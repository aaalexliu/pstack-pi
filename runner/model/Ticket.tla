---- MODULE Ticket ----
\* One ticket under the thin runner. The lead builds, opens PRs, has a fresh
\* reviewer post its review on each PR, fixes, merges, asks Alex and closes the
\* ticket, all through GitHub and Linear itself. The runner knows nothing about
\* PRs. It makes two writes: it starts the lead, and it files a Decision issue
\* when the lead stopped and nothing is left to wait for.
\* The runner remembers one fact per ticket: up to when the lead saw every event.
CONSTANTS EVENT_CHECK,         \* fix: start the lead only on an event since its last start
          TWO_STEP_DECISION    \* bug: file the Decision issue, then link it, instead of one write with a parent

VARIABLES lead,     \* "live" | "idle": the tmux session
          event,    \* someone other than the runner acted in Linear since the lead's last start
          dec,      \* an open Decision issue exists for the ticket
          linked,   \* the runner can find that issue
          dup,      \* history: a second Decision issue for one ask
          spun,     \* history: the lead was started with nothing new
          done      \* the ticket is Done or Canceled
vars == <<lead, event, dec, linked, dup, spun, done>>

Init == lead = "idle" /\ event = TRUE /\ dec = FALSE /\ linked = FALSE
     /\ dup = FALSE /\ spun = FALSE /\ done = FALSE

Found == dec /\ linked
Idle == lead = "idle" /\ ~done

\* ---- the lead: how a session ends ----
\* The lead calls subagent_done once its ending is in place; a turn end alone
\* does not end it. The runner acts only on a ticket with no live lead, so a
\* live lead's steps, quiet or not, are the lead's own. The nudge and the
\* investigator for a quiet live lead change no state here; the model leaves them out.
LeadAsks == lead = "live" /\ ~dec /\ lead' = "idle" /\ dec' = TRUE /\ linked' = TRUE
    /\ UNCHANGED <<event, dup, spun, done>>
\* It merged its last PR ("Fixes KEY") or posted its report.
LeadCloses == lead = "live" /\ lead' = "idle" /\ done' = TRUE
    /\ UNCHANGED <<event, dec, linked, dup, spun>>
\* Alex's comment answered its open Decision issue, so it closed the issue
\* itself. That closure is the runner's own act, so it is not an event.
LeadClosesDecision == lead = "live" /\ dec /\ dec' = FALSE /\ linked' = FALSE
    /\ UNCHANGED <<lead, event, dup, spun, done>>
\* It crashed, lost its way, or ran out of quota.
LeadJustExits == lead = "live" /\ lead' = "idle"
    /\ UNCHANGED <<event, dec, linked, dup, spun, done>>

\* ---- the runner: two writes ----
\* An event starts the lead even with a Decision issue open: Alex may answer it
\* anywhere, and the lead judges what the event means.
StartsLead == Idle /\ (event \/ ~Found) /\ (event \/ ~EVENT_CHECK)
    /\ lead' = "live" /\ event' = FALSE /\ spun' = (spun \/ ~event)
    /\ UNCHANGED <<dec, linked, dup, done>>
FilesDecision == Idle /\ ~Found /\ ~event
    /\ dup' = (dup \/ dec) /\ dec' = TRUE /\ linked' = ~TWO_STEP_DECISION
    /\ UNCHANGED <<lead, event, spun, done>>
LinksDecision == dec /\ ~linked /\ linked' = TRUE
    /\ UNCHANGED <<lead, event, dec, dup, spun, done>>

\* ---- Alex ----
\* Done or canceled: either way the lead reads it and carries on or stops.
AlexClosesDecision == dec /\ ~done /\ dec' = FALSE /\ linked' = FALSE /\ event' = TRUE
    /\ UNCHANGED <<lead, dup, spun, done>>
\* Any other event, at any time, while a Decision issue is open or not: a comment
\* on the ticket or a sub-issue, a label, title or delegate change.
SomeoneActs == ~done /\ event' = TRUE
    /\ UNCHANGED <<lead, dec, linked, dup, spun, done>>
Finished == done /\ UNCHANGED vars

Next == LeadAsks \/ LeadCloses \/ LeadClosesDecision \/ LeadJustExits \/ StartsLead \/ FilesDecision
     \/ LinksDecision \/ AlexClosesDecision \/ SomeoneActs \/ Finished
Spec == Init /\ [][Next]_vars

\* ---- rules: each is a bug one of the runner's two writes could have ----
NoSpin == ~spun              \* the lead never restarts without an event
OneDecisionPerAsk == ~dup    \* one ask, one Decision issue
\* NoDeadlock (built in): an open ticket always has someone who moves it.
====
