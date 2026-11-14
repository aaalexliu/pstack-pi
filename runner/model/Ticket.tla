---- MODULE Ticket ----
\* One ticket under the thin runner. The lead builds, opens PRs, has a fresh
\* reviewer post its review on each PR, fixes, merges, asks Alex and closes the
\* ticket, all through GitHub and Linear itself. The runner knows nothing about
\* PRs. It makes two writes: it starts the lead, and it files a Decision issue
\* when the lead stopped and nothing is left to wait for.
\* The runner remembers one fact: when it last started the lead.
CONSTANTS NEWS_CHECK,          \* fix: start the lead only when Alex acted after its last start
          TWO_STEP_DECISION    \* bug: file the Decision issue, then link it, instead of one write with a parent

VARIABLES lead,     \* "live" | "idle": the tmux session
          news,     \* Alex acted after the lead's last start (delegated, answered, canceled)
          dec,      \* an open Decision issue exists for the ticket
          linked,   \* the runner can find that issue
          dup,      \* history: a second Decision issue for one ask
          spun,     \* history: the lead was started with nothing new
          done      \* the ticket is Done or Canceled
vars == <<lead, news, dec, linked, dup, spun, done>>

Init == lead = "idle" /\ news = TRUE /\ dec = FALSE /\ linked = FALSE
     /\ dup = FALSE /\ spun = FALSE /\ done = FALSE

Found == dec /\ linked
Idle == lead = "idle" /\ ~done

\* ---- the lead: how a session ends ----
LeadAsks == lead = "live" /\ ~dec /\ lead' = "idle" /\ dec' = TRUE /\ linked' = TRUE
    /\ UNCHANGED <<news, dup, spun, done>>
\* It merged its last PR ("Fixes KEY") or posted its report.
LeadCloses == lead = "live" /\ lead' = "idle" /\ done' = TRUE
    /\ UNCHANGED <<news, dec, linked, dup, spun>>
\* It crashed, lost its way, or ran out of quota.
LeadJustExits == lead = "live" /\ lead' = "idle"
    /\ UNCHANGED <<news, dec, linked, dup, spun, done>>

\* ---- the runner: two writes ----
StartsLead == Idle /\ ~Found /\ (news \/ ~NEWS_CHECK)
    /\ lead' = "live" /\ news' = FALSE /\ spun' = (spun \/ ~news)
    /\ UNCHANGED <<dec, linked, dup, done>>
FilesDecision == Idle /\ ~Found /\ ~news
    /\ dup' = (dup \/ dec) /\ dec' = TRUE /\ linked' = ~TWO_STEP_DECISION
    /\ UNCHANGED <<lead, news, spun, done>>
LinksDecision == dec /\ ~linked /\ linked' = TRUE
    /\ UNCHANGED <<lead, news, dec, dup, spun, done>>

\* ---- Alex ----
\* Done or canceled: either way the lead reads it and carries on or stops.
AlexClosesDecision == dec /\ ~done /\ dec' = FALSE /\ linked' = FALSE /\ news' = TRUE
    /\ UNCHANGED <<lead, dup, spun, done>>
Finished == done /\ UNCHANGED vars

Next == LeadAsks \/ LeadCloses \/ LeadJustExits \/ StartsLead \/ FilesDecision
     \/ LinksDecision \/ AlexClosesDecision \/ Finished
Spec == Init /\ [][Next]_vars

\* ---- rules: each is a bug one of the runner's two writes could have ----
NoSpin == ~spun              \* the lead never restarts with nothing new
OneDecisionPerAsk == ~dup    \* one ask, one Decision issue
\* NoDeadlock (built in): an open ticket always has someone who moves it.
====
