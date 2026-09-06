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

# The worker owns a process group and records even `exit` in the user's shell.
WORKER = r'''
import json, os, signal, subprocess, sys
from pathlib import Path
job = Path(sys.argv[1])
request = json.loads((job / 'request.json').read_text())
signal.signal(signal.SIGTERM, lambda *_: None)
stamp = Path('/proc/self/stat').read_text().rsplit(')', 1)[1].split()[19]
(job / 'state.tmp').write_text(json.dumps({'pid': os.getpid(), 'stamp': stamp}))
(job / 'state.tmp').replace(job / 'state.json')
try:
    child = subprocess.Popen(['bash', '-c', request['command']], cwd=request['workdir'], stdin=subprocess.DEVNULL)
    code = child.wait()
except Exception as error:
    print(str(error), file=sys.stderr, flush=True)
    code = 127
(job / 'exit.tmp').write_text(str(code))
(job / 'exit.tmp').replace(job / 'exit')
'''


def alive(state):
    try:
        stat = Path('/proc/%s/stat' % state['pid']).read_text().rsplit(')', 1)[1].split()
        return stat[0] != 'Z' and stat[19] == state['stamp']
    except FileNotFoundError:
        return False


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
