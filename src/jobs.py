"""Remote Linux job operations, invoked over SSH with a JSON request on stdin."""
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
request = json.loads((job / 'request.json').read_text())
pid = os.getpid()
stopping = None

def terminate(*_):
    global stopping
    if stopping is None:
        stopping = time.monotonic()
        (job / 'killed').touch()
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

signal.signal(signal.SIGTERM, terminate)
stamp = Path('/proc/self/stat').read_text().rsplit(')', 1)[1].split()[19]
(job / 'state.tmp').write_text(json.dumps({'pid': pid, 'stamp': stamp, 'version': 2}))
(job / 'state.tmp').replace(job / 'state.json')

def members_remain():
    for entry in os.scandir('/proc'):
        if not entry.name.isdigit() or int(entry.name) == pid:
            continue
        try:
            info = Path(entry.path, 'stat').read_text().rsplit(')', 1)[1].split()
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
        if info[0] != 'Z' and int(info[2]) == pid and int(info[3]) == pid:
            return True
    return False

try:
    child = subprocess.Popen(['bash', '-c', request['command']], cwd=request['workdir'], stdin=subprocess.DEVNULL)
except Exception as error:
    print(str(error), file=sys.stderr, flush=True)
    child = None
recorded = False
while True:
    code = child.poll() if child is not None else 127
    if code is not None:
        if not recorded:
            (job / 'exit.tmp').write_text(str(code))
            (job / 'exit.tmp').replace(job / 'exit')
            recorded = True
        if not members_remain():
            break
    if stopping is not None and time.monotonic() - stopping >= 3:
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    time.sleep(0.05)
'''


def alive(state):
    try:
        stat = Path('/proc/%s/stat' % state['pid']).read_text().rsplit(')', 1)[1].split()
        return stat[0] != 'Z' and stat[19] == state['stamp']
    except (FileNotFoundError, ProcessLookupError):
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
        (job / 'request.json').write_text(json.dumps(request))
        # ponytail: logs remain on disk until explicit cleanup; add rotation if long jobs need a disk quota.
        with (job / 'out').open('wb') as output:
            worker = subprocess.Popen([sys.executable, '-c', WORKER, str(job)], stdin=subprocess.DEVNULL,
                                      stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        deadline = time.monotonic() + 5
        while not (job / 'state.json').exists():
            if worker.poll() is not None or time.monotonic() >= deadline:
                raise RuntimeError('Job failed to initialize; inspect job %s' % job_id)
            time.sleep(0.01)
        return {'job_id': job_id, 'status': 'started'}
    state = json.loads((job / 'state.json').read_text())
    if action == 'kill' and alive(state):
        (job / 'killed').touch()
        try:
            if state.get('version', 1) >= 2:
                signal_worker(state, signal.SIGTERM)
                deadline = time.monotonic() + 4
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
        except ProcessLookupError:
            pass
    if action not in ('output', 'kill'):
        raise ValueError('Unknown job action')
    running = alive(state)
    exit_file = job / 'exit'
    code = int(exit_file.read_text()) if exit_file.exists() else None
    status = 'running' if running else ('killed' if (job / 'killed').exists() else 'completed' if code is not None else 'lost')
    offset = request.get('offset', 0)
    limit = request.get('limit', 65536)
    if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 65536:
        raise ValueError('Invalid output offset or limit')
    with (job / 'out').open('rb') as output:
        output.seek(offset)
        data = output.read(limit)
        next_offset = output.tell()
        has_more = bool(output.read(1))
    result = {'job_id': job_id, 'status': status, 'exit_code': code, 'output': data.decode('utf-8', errors='replace'),
              'next_offset': next_offset, 'has_more': has_more}
    if request.get('cleanup'):
        if running or has_more:
            raise ValueError('Cleanup requires a finished job with no unread output after this chunk')
        shutil.rmtree(job)
        result['cleaned_up'] = True
    return result


try:
    print(json.dumps(main(), ensure_ascii=False))
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
