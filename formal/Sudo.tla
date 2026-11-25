---- MODULE Sudo ----
\* Formal model of the information-flow contract of the `sudo` tool
\* (src/sudo.js) and its short-lived credential cache (src/sudocache.js).
\*
\* Accepted channels for the password: the local terminal variable, the private
\* local Unix socket that delivers it to the MCP process, the MCP process
\* memory cache (bounded by TTL clock ticks from entry), the ssh stdin pipe,
\* and the remote sudo stdin. The cache is an explicit, bounded trade-off: it
\* may hold the secret, but only until its deadline, and the password must
\* never reach a tool result, any file, any log line, or any process argv.
\*
\* `Leak = TRUE` models a broken design that also copies the password into an
\* observable channel; TLC then refutes ObservableSecrecy, demonstrating that
\* the model is sensitive to the property it checks.

EXTENDS Naturals, TLC

CONSTANTS TTL, Leak

SECRET == "secret"
NONE   == "none"
PUBLIC == "public"

Values == {NONE, PUBLIC, SECRET}

VARIABLES
  term,      \* local terminal shell variable
  sock,      \* private local Unix socket, delivery in flight
  cache,     \* MCP process memory (the sudo password cache)
  cachedAt,  \* clock tick at which the cache was filled
  clock,     \* monotonic model time
  sshIn,     \* bytes on the ssh stdin pipe
  remoteIn,  \* bytes read by the remote sudo
  result,    \* tool result returned to the model
  disk,      \* any file on either host
  log,       \* any log line
  argv       \* any process argument vector

Vars == <<term, sock, cache, cachedAt, clock, sshIn, remoteIn, result, disk, log, argv>>

Init ==
  /\ term = NONE /\ sock = NONE /\ cache = NONE /\ cachedAt = 0 /\ clock = 0
  /\ sshIn = NONE /\ remoteIn = NONE
  /\ result = NONE /\ disk = NONE /\ log = NONE /\ argv = NONE

\* The user types the password into the local terminal.
TypeSecret ==
  /\ term' = SECRET
  /\ UNCHANGED <<sock, cache, cachedAt, clock, sshIn, remoteIn, result, disk, log, argv>>

\* The terminal hands the password to the service over the private socket.
SendToMcp ==
  /\ sock' = term /\ term' = NONE
  /\ UNCHANGED <<cache, cachedAt, clock, sshIn, remoteIn, result, disk, log, argv>>

\* The service keeps the password in its process memory for reuse.
Cache ==
  /\ cache' = sock /\ cachedAt' = clock /\ sock' = NONE
  /\ UNCHANGED <<term, clock, sshIn, remoteIn, result, disk, log, argv>>

\* Time passes; a cache entry past its absolute deadline is wiped. This models
\* the per-entry expiry timer in src/sudocache.js (lazy checks use the same
\* deadline, so the bound does not depend on a later call). The clock is
\* bounded so the model remains finite; two ticks past the deadline are enough
\* to observe expiry and a later reuse attempt.
MaxClock == TTL + 2

Tick ==
  /\ clock < MaxClock
  /\ clock' = clock + 1
  /\ cache' = IF cache = SECRET /\ clock' - cachedAt >= TTL THEN NONE ELSE cache
  /\ UNCHANGED <<term, sock, cachedAt, sshIn, remoteIn, result, disk, log, argv>>

\* A sudo call feeds a still-fresh cached password to ssh stdin.
CacheToSsh ==
  /\ cache = SECRET
  /\ clock - cachedAt < TTL
  /\ sshIn' = cache
  /\ UNCHANGED <<term, sock, cache, cachedAt, clock, remoteIn, result, disk, log, argv>>

\* sudo reads the password from stdin, then erases its copy.
Consume ==
  /\ remoteIn' = sshIn /\ sshIn' = NONE
  /\ UNCHANGED <<term, sock, cache, cachedAt, clock, result, disk, log, argv>>

Erase ==
  /\ remoteIn' = NONE
  /\ UNCHANGED <<term, sock, cache, cachedAt, clock, sshIn, result, disk, log, argv>>

\* The command's output (never the password) reaches the MCP and the model.
CommandOutput ==
  /\ result' = PUBLIC
  /\ UNCHANGED <<term, sock, cache, cachedAt, clock, sshIn, remoteIn, disk, log, argv>>

Persist ==
  /\ disk' = PUBLIC
  /\ UNCHANGED <<term, sock, cache, cachedAt, clock, sshIn, remoteIn, result, log, argv>>

LogLine ==
  /\ log' = PUBLIC
  /\ UNCHANGED <<term, sock, cache, cachedAt, clock, sshIn, remoteIn, result, disk, argv>>

Argv ==
  /\ argv' = PUBLIC
  /\ UNCHANGED <<term, sock, cache, cachedAt, clock, sshIn, remoteIn, result, disk, log>>

\* Broken design (Leak = TRUE): the password escapes to an observable channel.
\* One action per channel so every unmentioned variable stays unchanged.
LeakToResult ==
  /\ Leak = TRUE
  /\ cache = SECRET
  /\ result' = SECRET
  /\ UNCHANGED <<term, sock, cache, cachedAt, clock, sshIn, remoteIn, disk, log, argv>>

LeakToDisk ==
  /\ Leak = TRUE
  /\ cache = SECRET
  /\ disk' = SECRET
  /\ UNCHANGED <<term, sock, cache, cachedAt, clock, sshIn, remoteIn, result, log, argv>>

LeakToLog ==
  /\ Leak = TRUE
  /\ cache = SECRET
  /\ log' = SECRET
  /\ UNCHANGED <<term, sock, cache, cachedAt, clock, sshIn, remoteIn, result, disk, argv>>

LeakToArgv ==
  /\ Leak = TRUE
  /\ cache = SECRET
  /\ argv' = SECRET
  /\ UNCHANGED <<term, sock, cache, cachedAt, clock, sshIn, remoteIn, result, disk, log>>

Next == TypeSecret \/ SendToMcp \/ Cache \/ Tick \/ CacheToSsh \/ Consume \/ Erase
        \/ CommandOutput \/ Persist \/ LogLine \/ Argv
        \/ LeakToResult \/ LeakToDisk \/ LeakToLog \/ LeakToArgv

Spec == Init /\ [][Next]_Vars

TypeOK ==
  /\ term \in Values /\ sock \in Values /\ cache \in Values
  /\ sshIn \in Values /\ remoteIn \in Values
  /\ result \in Values /\ disk \in Values /\ log \in Values /\ argv \in Values
  /\ clock \in Nat /\ cachedAt \in Nat

\* The password never reaches a tool result, any file, any log, or argv.
ObservableSecrecy ==
  /\ result # SECRET
  /\ disk # SECRET
  /\ log # SECRET
  /\ argv # SECRET

\* A cached copy is wiped by the time its absolute deadline passes.
CacheBounded ==
  cache = SECRET => clock - cachedAt < TTL

====
