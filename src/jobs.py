"""Remote Linux job operations, invoked over SSH with a JSON request on stdin."""
import codecs
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time

# The worker stays alive until all non-zombie members of its process group
# finish, not just the immediate shell. It owns TERM/KILL escalation itself:
# its live PID pins the process group identity while it sends signals, and
# killing/cancelling the SSH request cannot interrupt the escalation.
WORKER = r'''
import json, os, signal, subprocess, sys, time
from pathlib import Path
job = Path(sys.argv[1])
request = json.loads((job / 'request.json').read_text(encoding='utf-8'))
pid = os.getpid()
stopping = None

def members():
    """Live processes in the job's process group OR session, excluding us.

    A shell that enables job control (`set -m`) puts a child in a new process
    group but keeps the session, so checking both is required to notice (and
    terminate) that child.
    """
    for entry in os.scandir('/proc'):
        if not entry.name.isdigit() or int(entry.name) == pid:
            continue
        try:
            info = Path(entry.path, 'stat').read_text().rsplit(')', 1)[1].split()
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
        if info[0] != 'Z' and (int(info[2]) == pid or int(info[3]) == pid):
            yield int(entry.name)

def signal_members(sig):
    for member in members():
        try:
            os.kill(member, sig)
        except (ProcessLookupError, PermissionError):
            pass

def terminate(*_):
    global stopping
    if stopping is None:
        stopping = time.monotonic()
        (job / 'killed').touch()
        signal_members(signal.SIGTERM)

signal.signal(signal.SIGTERM, terminate)
stamp = Path('/proc/self/stat').read_text().rsplit(')', 1)[1].split()[19]
(job / 'state.tmp').write_text(json.dumps({'pid': pid, 'stamp': stamp, 'version': 3}))
(job / 'state.tmp').replace(job / 'state.json')

def members_remain():
    for _ in members():
        return True
    return False

try:
    if stopping is not None:
        # A kill arrived between publishing state.json and starting the child:
        # do not launch the command at all.
        print('job cancelled before start', file=sys.stderr, flush=True)
        child = None
    else:
        command = job / 'command.sh'
        command.write_text(request['command'], encoding='utf-8')
        child = subprocess.Popen(['bash', str(command)], cwd=request['workdir'], stdin=subprocess.DEVNULL)
except Exception as error:
    print(str(error), file=sys.stderr, flush=True)
    child = None
recorded = False
quiet = 0
escalated_at = 0.0
while True:
    code = child.poll() if child is not None else 127
    if code is not None:
        if not recorded:
            (job / 'exit.tmp').write_text(str(code))
            (job / 'exit.tmp').replace(job / 'exit')
            recorded = True
        # Two consecutive empty scans guard against a member forked between
        # the final scan and the worker exiting.
        if members_remain():
            quiet = 0
        else:
            quiet += 1
            if quiet >= 2:
                # Bookkeeping finished normally. A v3 worker killed after the
                # direct child exited but before this marker (OOM, kill -9)
                # leaves no marker, so its job is reported as lost even though
                # an exit file may exist.
                (job / 'done').touch()
                break
    if stopping is not None and time.monotonic() - stopping >= 3:
        # Signal members individually: a setpgid child left the group but
        # stayed in the session and must not escape the escalation. Repeat at
        # most once per second; a blocked/D-state member must not turn this
        # loop into a 20 Hz /proc scan.
        now = time.monotonic()
        if now - escalated_at >= 1:
            signal_members(signal.SIGKILL)
            escalated_at = now
    # Poll the direct child tightly; scanning /proc for lingering members is
    # much more expensive, so slow down once the child has exited.
    time.sleep(0.05 if code is None else 0.25)
'''


def alive(state):
    try:
        stat = Path('/proc/%s/stat' % state['pid']).read_text().rsplit(')', 1)[1].split()
        return stat[0] != 'Z' and stat[19] == state['stamp']
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        return False


def signal_worker(state, sig):
    # pidfd ties delivery to a specific process on supported Linux kernels.
    # Re-check the saved start time after opening it to reject PID reuse.
    if hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal'):
        try:
            fd = os.pidfd_open(state['pid'])
        except OSError:
            pass  # vanished, EMFILE, or an old kernel: use the checked fallback
        else:
            try:
                if alive(state):
                    signal.pidfd_send_signal(fd, sig)
            except OSError:
                pass  # worker exited between the check and delivery
            finally:
                os.close(fd)
            return
    if alive(state):
        try:
            os.kill(state['pid'], sig)
        except ProcessLookupError:
            pass


def main():
    request = json.load(sys.stdin)
    job_id = request['job_id']
    if not re.fullmatch(r'[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}', job_id):
        raise ValueError('Invalid job ID')
    os.umask(0o077)
    root = Path(os.environ.get('REMOTE_SSH_JOB_DIR', str(Path.home() / '.cache' / 'remote-ssh' / 'jobs')))
    job = root / job_id
    if job.is_symlink():
        raise ValueError('Refusing a symlink job directory')
    action = request['action']
    if action == 'start':
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        job.mkdir(mode=0o700)
        worker = None
        try:
            (job / 'request.json').write_text(json.dumps(request), encoding='utf-8')
            # ponytail: logs remain on disk until explicit cleanup; add rotation if long jobs need a disk quota.
            with (job / 'out').open('wb') as output:
                worker = subprocess.Popen([sys.executable, '-c', WORKER, str(job)], stdin=subprocess.DEVNULL,
                                          stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
            deadline = time.monotonic() + 10
            while not (job / 'state.json').exists():
                if worker.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError('Job failed to initialize; the job record was removed')
                time.sleep(0.01)
        except Exception:
            # A worker that has not published state.json cannot be observed or
            # cleaned up later; terminate it and remove the orphan record.
            if worker is not None:
                try:
                    os.killpg(worker.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
            shutil.rmtree(job, ignore_errors=True)
            raise
        return {'job_id': job_id, 'status': 'started'}
    state = json.loads((job / 'state.json').read_text(encoding='utf-8'))
    if action == 'kill' and alive(state):
        (job / 'killed').touch()
        try:
            if state.get('version', 1) >= 2:
                signal_worker(state, signal.SIGTERM)
                # The worker escalates at 3s and then needs up to two
                # quiet scans (0.5s) before it exits; allow ample slack.
                deadline = time.monotonic() + 8
                while alive(state) and time.monotonic() < deadline:
                    time.sleep(0.05)
                # If a stopped/unresponsive worker remains, report running,
                # not killed. The worker escalates when it can run again.
            else:
                # Compatibility for jobs started by an older release. Their
                # worker cannot be hot-upgraded and has the old guarantees.
                os.killpg(state['pid'], signal.SIGTERM)
                deadline = time.monotonic() + 3
                while alive(state) and time.monotonic() < deadline:
                    time.sleep(0.05)
                if alive(state):
                    os.killpg(state['pid'], signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    if action not in ('output', 'kill'):
        raise ValueError('Unknown job action')
    running = alive(state)
    exit_file = job / 'exit'
    code = int(exit_file.read_text()) if exit_file.exists() else None
    version = state.get('version', 1)
    finished = (job / 'done').exists()
    # v3 workers publish `done` only after they proved their members stopped.
    # A dead worker without it (even with an exit file or a killed marker) is
    # lost: its descendants may still be running, so cleanup must be refused.
    clean = version < 3 or finished
    status = 'running' if running else (
        'killed' if (job / 'killed').exists() and clean else
        'completed' if code is not None and clean else
        'lost')
    offset = request.get('offset', 0)
    limit = request.get('limit', 65536)
    if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 65536:
        raise ValueError('Invalid output offset or limit')
    # Keep a UTF-8 character split at a page boundary for the next page: read
    # only complete characters and let next_offset point at the pending bytes.
    # A running (or lost) job may still append the rest of the character, so
    # only finalize a trailing incomplete sequence once the job cannot write.
    with (job / 'out').open('rb') as output:
        output.seek(offset)
        raw = output.read(limit)
        decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')
        text = decoder.decode(raw, final=len(raw) < limit and status not in ('running', 'lost'))
        buffered, _ = decoder.getstate()
        next_offset = offset + len(raw) - len(buffered)
        output.seek(next_offset)
        has_more = bool(output.read(1))
    result = {'job_id': job_id, 'status': status, 'exit_code': code, 'output': text,
              'next_offset': next_offset, 'has_more': has_more}
    if status == 'lost':
        result['worker_missing'] = True
        result['warning'] = 'the job worker is not running; descendants may still be running'
    if request.get('cleanup'):
        if running or has_more:
            raise ValueError('Cleanup requires a finished job with no unread output after this chunk')
        if status == 'lost':
            # The worker is gone, so it cannot prove that descendants stopped;
            # deleting the log could silently discard output still being
            # written by a surviving group/session member.
            raise ValueError('Refusing cleanup of a lost job: its worker did not finish and descendants may still be running; verify on the remote host first')
        shutil.rmtree(job)
        result['cleaned_up'] = True
    return result


if __name__ == '__main__':
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='backslashreplace')
        except (AttributeError, ValueError):
            pass
    try:
        print(json.dumps(main(), ensure_ascii=True))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
