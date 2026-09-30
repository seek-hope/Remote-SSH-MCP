---- MODULE Jobs ----
\* Formal model of the remote background-job lifecycle in src/jobs.py.
\*
\* Scope: the safety contract exposed to callers
\*   - a job directory is never removed while its worker is alive;
\*   - a job directory is never removed while output is still unread (cleanup
\*     requires the read to have reached the end of the output file);
\*   - the reported status is derived only from recorded facts (running pid,
\*     exit code, killed marker), so it can never contradict them.
\*
\* `SafeCleanup = FALSE` models a hypothetical cleanup that drops those checks;
\* TLC then refutes NoUnreadOutputLost, showing the model is sensitive to the
\* guard it is supposed to verify.

EXTENDS Naturals, TLC

CONSTANTS MaxBytes, SafeCleanup

VARIABLES
  exists,        \* job directory present
  running,       \* worker process alive
  exitRecorded,  \* exit file written
  killed,        \* killed marker present
  outLen,        \* bytes in the output file (monotonic)
  readPos        \* offset reached by the caller's last read

vars == <<exists, running, exitRecorded, killed, outLen, readPos>>

Init ==
  /\ exists = FALSE
  /\ running = FALSE /\ exitRecorded = FALSE /\ killed = FALSE
  /\ outLen = 0 /\ readPos = 0

Start ==
  /\ ~exists
  /\ exists' = TRUE /\ running' = TRUE
  /\ exitRecorded' = FALSE /\ killed' = FALSE
  /\ outLen' = 0 /\ readPos' = 0

Emit ==
  /\ exists /\ running /\ outLen < MaxBytes
  /\ outLen' = outLen + 1
  /\ UNCHANGED <<exists, running, exitRecorded, killed, readPos>>

Finish ==
  /\ exists /\ running
  /\ running' = FALSE /\ exitRecorded' = TRUE
  /\ UNCHANGED <<exists, killed, outLen, readPos>>

\* The worker dies without the wrapper ever writing an exit code.
CrashWorker ==
  /\ exists /\ running
  /\ running' = FALSE
  /\ UNCHANGED <<exists, exitRecorded, killed, outLen, readPos>>

Kill ==
  /\ exists /\ running
  /\ killed' = TRUE /\ running' = FALSE
  /\ UNCHANGED <<exists, exitRecorded, outLen, readPos>>

\* The worker's `wait` returns and it writes the exit file.
RecordExit ==
  /\ exists /\ ~running /\ ~exitRecorded
  /\ exitRecorded' = TRUE
  /\ UNCHANGED <<exists, running, killed, outLen, readPos>>

\* Read one more byte (limit modelled as a single step).
Read ==
  /\ exists
  /\ readPos' = (IF readPos + 1 > outLen THEN outLen ELSE readPos + 1)
  /\ UNCHANGED <<exists, running, exitRecorded, killed, outLen>>

Cleanup ==
  /\ exists
  /\ (SafeCleanup = TRUE => (~running /\ readPos = outLen))
  /\ exists' = FALSE
  /\ UNCHANGED <<running, exitRecorded, killed, outLen, readPos>>

Next == Start \/ Emit \/ Finish \/ CrashWorker \/ Kill \/ RecordExit \/ Read \/ Cleanup

Spec == Init /\ [][Next]_vars

Status ==
  IF ~exists THEN "gone"
  ELSE IF running THEN "running"
  ELSE IF killed THEN "killed"
  ELSE IF exitRecorded THEN "completed"
  ELSE "lost"

TypeOK ==
  /\ exists \in BOOLEAN
  /\ running \in BOOLEAN
  /\ exitRecorded \in BOOLEAN
  /\ killed \in BOOLEAN
  /\ outLen \in 0..MaxBytes
  /\ readPos \in 0..MaxBytes

\* SAFETY: a job directory is never removed while its worker is alive.
NoCleanupWhileRunning == ~exists => ~running

\* SAFETY: a job directory is never removed with output still unread.
NoUnreadOutputLost == ~exists => readPos = outLen

\* SAFETY: the reported status never contradicts the recorded facts.
StatusConsistent ==
  /\ (Status = "killed") => killed
  /\ (Status = "completed") => exitRecorded
  /\ (Status = "running") => running

====
