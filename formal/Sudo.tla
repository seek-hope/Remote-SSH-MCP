---- MODULE Sudo ----
\* Formal model of the information-flow contract of the `sudo` tool
\* (src/sudo.js): the sudo password may only ever live in the local terminal
\* variable, the ssh stdin pipe, and the remote sudo stdin. It must never
\* appear in MCP process state, the tool result, any file, any log line, or any
\* process argv.
\*
\* `ViaMcp = TRUE` models the rejected design in which the password is routed
\* through the MCP process; TLC then refutes Secrecy, demonstrating that the
\* model distinguishes the two designs.

EXTENDS Naturals, TLC

CONSTANTS ViaMcp

SECRET == "secret"
NONE   == "none"
PUBLIC == "public"

Values == {NONE, PUBLIC, SECRET}

VARIABLES
  term,      \* local terminal shell variable
  sshIn,     \* bytes on the ssh stdin pipe
  remoteIn,  \* bytes read by the remote sudo
  mcp,       \* MCP process state
  result,    \* tool result returned to the model
  disk,      \* any file on either host
  log,       \* any log line
  argv       \* any process argument vector

Vars == <<term, sshIn, remoteIn, mcp, result, disk, log, argv>>

Init ==
  /\ term = NONE /\ sshIn = NONE /\ remoteIn = NONE
  /\ mcp = NONE /\ result = NONE /\ disk = NONE /\ log = NONE /\ argv = NONE

\* The user types the password into the terminal.
TypeSecret ==
  /\ term' = SECRET
  /\ UNCHANGED <<sshIn, remoteIn, mcp, result, disk, log, argv>>

\* The terminal pipes the password straight into ssh's stdin.
PipeDirect ==
  /\ sshIn' = term /\ term' = NONE
  /\ UNCHANGED <<remoteIn, mcp, result, disk, log, argv>>

\* Rejected design: the password travels through the MCP process.
PipeViaMcp ==
  /\ ViaMcp = TRUE
  /\ mcp' = term /\ term' = NONE
  /\ UNCHANGED <<sshIn, remoteIn, result, disk, log, argv>>

McpToSsh ==
  /\ ViaMcp = TRUE
  /\ sshIn' = mcp /\ mcp' = NONE
  /\ UNCHANGED <<term, remoteIn, result, disk, log, argv>>

\* sudo reads the password from stdin, then erases its copy.
Consume ==
  /\ remoteIn' = sshIn /\ sshIn' = NONE
  /\ UNCHANGED <<term, mcp, result, disk, log, argv>>

Erase ==
  /\ remoteIn' = NONE
  /\ UNCHANGED <<term, sshIn, mcp, result, disk, log, argv>>

\* The command's output (never the password) reaches the MCP and the model.
CommandOutput ==
  /\ result' = PUBLIC /\ mcp' = PUBLIC
  /\ UNCHANGED <<term, sshIn, remoteIn, disk, log, argv>>

Persist ==
  /\ disk' = PUBLIC
  /\ UNCHANGED <<term, sshIn, remoteIn, mcp, result, log, argv>>

LogLine ==
  /\ log' = PUBLIC
  /\ UNCHANGED <<term, sshIn, remoteIn, mcp, result, disk, argv>>

Argv ==
  /\ argv' = PUBLIC
  /\ UNCHANGED <<term, sshIn, remoteIn, mcp, result, disk, log>>

Next == TypeSecret \/ PipeDirect \/ PipeViaMcp \/ McpToSsh \/ Consume \/ Erase
        \/ CommandOutput \/ Persist \/ LogLine \/ Argv

Spec == Init /\ [][Next]_Vars

TypeOK ==
  /\ term \in Values /\ sshIn \in Values /\ remoteIn \in Values
  /\ mcp \in Values /\ result \in Values /\ disk \in Values
  /\ log \in Values /\ argv \in Values

\* The password never reaches any observable/non-transport channel.
Secrecy ==
  /\ mcp # SECRET
  /\ result # SECRET
  /\ disk # SECRET
  /\ log # SECRET
  /\ argv # SECRET

====
