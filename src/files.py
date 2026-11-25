"""One-shot remote file operations (Python 3.9+, no installed agent)."""
import hashlib
import io
import json
import os
import stat
import sys
import tempfile

MAX_EDIT_BYTES = 4 * 1024 * 1024
MAX_READ_BYTES = 1024 * 1024
MAX_READ_LINES = 2000
# Files up to this size also report an exact total line count. Larger files
# only return the requested window, so paging does not rescan the whole file.
TOTAL_LINES_SCAN_BYTES = 8 * 1024 * 1024


def fingerprint(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def atomic_write(path, source, size, digest=None, expected=None):
    """Verify the entire input before replacing; a valid prefix is not success.

    Symlinks are followed: the target file is replaced and the link stays a
    link. An existing non-regular target (FIFO, device, directory) is refused.
    New files stay private (0600). Existing permission bits are preserved;
    failures to preserve them are fatal. This is atomic replacement, not a
    filesystem lock or a promise of durability across power loss.
    """
    path = os.path.realpath(path)
    parent = os.path.dirname(path)
    os.makedirs(parent, exist_ok=True)
    try:
        existing = os.stat(path)
    except FileNotFoundError:
        existing = None
    if existing is not None and not stat.S_ISREG(existing.st_mode):
        raise ValueError('refusing to replace a non-regular file')
    existing_mode = stat.S_IMODE(existing.st_mode) if existing is not None else None
    fd, tmp = tempfile.mkstemp(prefix='.remote-ssh-tmp-', dir=parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            received = 0
            checksum = hashlib.sha256()
            while True:
                chunk = source.read(min(65536, size - received + 1))
                if not chunk:
                    break
                received += len(chunk)
                if received > size:
                    raise ValueError('upload integrity check failed: too many bytes')
                checksum.update(chunk)
                output.write(chunk)
            if received != size or (digest is not None and checksum.hexdigest() != digest):
                raise ValueError('upload integrity check failed: byte count or SHA-256 differs')
            if existing_mode is not None:
                os.fchmod(output.fileno(), existing_mode)
        # Check after writing and closing the temporary file, immediately
        # before replacing. Non-cooperating writers can still race this check.
        if expected is not None:
            try:
                current = fingerprint(os.stat(path))
            except FileNotFoundError:
                current = None
            if current != expected:
                raise ValueError('file changed during edit; re-read the file and reconcile before retrying')
        os.replace(tmp, path)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


def open_regular(path):
    """Open a regular file without blocking on a FIFO/device.

    O_NONBLOCK makes a writerless FIFO open return immediately; fstat then
    rejects anything that is not a regular file. This closes the stat/open
    race where a path is swapped for a FIFO after the check. The returned
    file object owns the descriptor.
    """
    flags = os.O_RDONLY | getattr(os, 'O_CLOEXEC', 0) | getattr(os, 'O_NONBLOCK', 0)
    fd = os.open(path, flags)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('not a regular file')
        return os.fdopen(fd, 'rb'), info
    except BaseException:
        os.close(fd)
        raise


def read_window(path, offset, limit):
    if offset < 1 or not 1 <= limit <= MAX_READ_LINES:
        raise ValueError('invalid read offset or limit')
    source, info = open_regular(path)
    eager_total = info.st_size <= TOTAL_LINES_SCAN_BYTES
    body, pending = bytearray(), bytearray()
    line = 1
    returned = 0
    newlines = 0
    last = b''
    byte_limited = False
    eof = False
    with source:
        # Count the whole file in one forward pass, but only split/retain the
        # requested window. Even a single enormous line uses bounded memory.
        # For files over TOTAL_LINES_SCAN_BYTES the pass stops once the window
        # is complete; the exact total is then unknown (null) instead of
        # rescanning the entire file on every page.
        for block in iter(lambda: source.read(65536), b''):
            count = block.count(b'\n')
            newlines += count
            last = block[-1:]
            if byte_limited or line >= offset + limit:
                if not eager_total:
                    break
                continue
            if line + count < offset:
                line += count
                continue
            parts = block.split(b'\n')
            for index, part in enumerate(parts):
                complete = index < len(parts) - 1
                if offset <= line < offset + limit:
                    fragment = part + (b'\n' if complete else b'')
                    if len(body) + len(pending) + len(fragment) > MAX_READ_BYTES:
                        if returned == 0:
                            raise ValueError('line %d exceeds the %d-byte read limit; use bash to inspect it' % (line, MAX_READ_BYTES))
                        pending.clear()
                        byte_limited = True
                        break
                    pending.extend(fragment)
                    if complete:
                        body.extend(pending)
                        pending.clear()
                        returned += 1
                if complete:
                    line += 1
                if line >= offset + limit:
                    break
        else:
            eof = True
    if pending and not byte_limited:
        body.extend(pending)
        returned += 1
    # Exact only when the scan reached EOF; large files report null.
    total = (newlines + int(bool(last) and last != b'\n')) if eof else None
    try:
        text = body.decode('utf-8')
    except UnicodeDecodeError:
        raise ValueError('file does not look like a UTF-8 text file (invalid encoding)') from None
    if '\0' in text:
        raise ValueError('file does not look like a UTF-8 text file (NUL bytes)')
    return {'text': text, 'total_lines': total, 'returned_lines': returned,
            'byte_limited': byte_limited, 'next_offset': offset + returned}


def edit_file(path, request):
    old, new = request['old_string'], request['new_string']
    if not old or '\0' in old or '\0' in new:
        raise ValueError('edit requires nonempty old_string and UTF-8 text without NUL')
    path = os.path.realpath(path)
    source, info = open_regular(path)
    with source:
        expected = fingerprint(info)
        data = source.read(MAX_EDIT_BYTES + 1)
        if fingerprint(os.fstat(source.fileno())) != expected:
            raise ValueError('file changed during read; re-read the file before retrying')
    if len(data) > MAX_EDIT_BYTES:
        raise ValueError('file exceeds %d bytes; remote edit refuses oversized files' % MAX_EDIT_BYTES)
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        raise ValueError('file does not look like a UTF-8 text file (invalid encoding)') from None
    if '\0' in text:
        raise ValueError('file does not look like a UTF-8 text file (NUL bytes)')
    count = text.count(old)
    if count == 0:
        raise ValueError('old_string not found')
    if count > 1 and not request.get('replace_all', False):
        raise ValueError('old_string appears %d times; provide a more specific old_string or set replace_all to true' % count)
    replaced = count if request.get('replace_all', False) else 1
    next_size = len(data) + replaced * (len(new.encode('utf-8')) - len(old.encode('utf-8')))
    if next_size > MAX_EDIT_BYTES:
        raise ValueError('edited result exceeds %d bytes' % MAX_EDIT_BYTES)
    result = text.replace(old, new, replaced).encode('utf-8')
    atomic_write(path, io.BytesIO(result), len(result), expected=expected)
    return {'replaced': replaced}


def main():
    action, path = sys.argv[1:3]
    if action == 'read':
        return read_window(path, int(sys.argv[3]), int(sys.argv[4]))
    if action == 'write':
        size = int(sys.argv[3])
        if size < 0:
            raise ValueError('invalid upload size')
        atomic_write(path, sys.stdin.buffer, size, digest=sys.argv[4])
        return {'bytes': size}
    if action == 'edit':
        return edit_file(path, json.load(sys.stdin))
    raise ValueError('unknown file action')


if __name__ == '__main__':
    # The MCP transport is UTF-8 JSON; do not depend on the remote account's
    # locale for stdin, stdout or stderr, and keep escaped filenames/errors
    # from raising again.
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='backslashreplace')
        except (AttributeError, ValueError):
            pass
    try:
        # ensure_ascii keeps the helper's stdout encodable under any locale.
        print(json.dumps(main(), ensure_ascii=True))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
