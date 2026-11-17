---- MODULE Ticket ----
\* One ticket under the thin runner. The lead builds, opens PRs, has a fresh
\* reviewer post its review on each PR, fixes, merges, asks Alex and closes the
\* ticket, all through GitHub and Linear itself. The runner knows nothing about
\* PRs. It starts the lead, unassigning Alex in the same write, and asks Alex
\* when the lead stopped with nothing handed in: it assigns him, then comments.
\* The ticket's assignee is who must act next. The runner remembers one fact
\* per ticket: up to when the lead saw every event.
CONSTANTS EVENT_CHECK,    \* fix: start the lead only on an event since its last start
          COMMENT_FIRST   \* bug: comment the ask, then assign Alex, instead of assign, then comment

VARIABLES lead,     \* "live" | "idle": the tmux session
          event,    \* someone other than the runner acted in Linear since the lead's last start
          asked,    \* an ask is open, so Alex is assigned
          noted,    \* the runner's ask comment for this wait is posted
          half,     \* the runner made the first of its ask's two writes and not the second
          dup,      \* history: a second runner ask comment for one wait
          spun,     \* history: the lead was started with nothing new
          done      \* the ticket is Done or Canceled
vars == <<lead, event, asked, noted, half, dup, spun, done>>

Init == lead = "idle" /\ event = TRUE /\ asked = FALSE /\ noted = FALSE
     /\ half = FALSE /\ dup = FALSE /\ spun = FALSE /\ done = FALSE

Idle == lead = "idle" /\ ~done /\ ~half

\* ---- the lead: how a session ends ----
\* The lead calls subagent_done once its ending is in place; a turn end alone
\* does not end it. The runner acts only on a ticket with no live lead, so a
\* live lead's steps, quiet or not, are the lead's own. The nudge and the
\* investigator for a quiet live lead change no state here; the model leaves them out.
\* It assigns Alex, comments its question and exits.
LeadAsks == lead = "live" /\ lead' = "idle" /\ asked' = TRUE
    /\ UNCHANGED <<event, noted, half, dup, spun, done>>
\* It merged its last PR ("Fixes KEY") or posted its report.
LeadCloses == lead = "live" /\ lead' = "idle" /\ done' = TRUE
    /\ UNCHANGED <<event, asked, noted, half, dup, spun>>
\* Alex's comment answered its ask, so it unassigned him. The runner's own act, so no event.
LeadUnassigns == lead = "live" /\ asked /\ asked' = FALSE
    /\ UNCHANGED <<lead, event, noted, half, dup, spun, done>>
\* It crashed, lost its way, or ran out of quota.
LeadJustExits == lead = "live" /\ lead' = "idle"
    /\ UNCHANGED <<event, asked, noted, half, dup, spun, done>>

\* ---- the runner ----
\* An event starts the lead even while Alex is assigned: the lead judges whether
\* it answers its ask. The start unassigns Alex in the same write.
StartsLead == Idle /\ (event \/ ~asked) /\ (event \/ ~EVENT_CHECK)
    /\ lead' = "live" /\ event' = FALSE /\ spun' = (spun \/ ~event)
    /\ asked' = FALSE /\ noted' = FALSE
    /\ UNCHANGED <<half, dup, done>>
\* The ask's first write: assign Alex, or, with the bug, comment.
AskStarts == Idle /\ ~asked /\ ~event /\ half' = TRUE
    /\ (IF COMMENT_FIRST THEN (noted' = TRUE /\ dup' = (dup \/ noted) /\ UNCHANGED asked)
                        ELSE (asked' = TRUE /\ UNCHANGED <<noted, dup>>))
    /\ UNCHANGED <<lead, event, spun, done>>
\* The second write: comment, or, with the bug, assign Alex.
AskEnds == half /\ half' = FALSE
    /\ (IF COMMENT_FIRST THEN (asked' = TRUE /\ UNCHANGED <<noted, dup>>)
                        ELSE (noted' = TRUE /\ dup' = (dup \/ noted) /\ UNCHANGED asked))
    /\ UNCHANGED <<lead, event, spun, done>>
\* The second write fails, or the runner crashes between the two.
AskFails == half /\ half' = FALSE
    /\ UNCHANGED <<lead, event, asked, noted, dup, spun, done>>

\* ---- Alex ----
\* Any event, at any time, assigned or not: a comment on the ticket or a
\* sub-issue, a label, title, assignee or delegate change.
SomeoneActs == ~done /\ event' = TRUE
    /\ UNCHANGED <<lead, asked, noted, half, dup, spun, done>>
Finished == done /\ UNCHANGED vars

Next == LeadAsks \/ LeadCloses \/ LeadUnassigns \/ LeadJustExits \/ StartsLead
     \/ AskStarts \/ AskEnds \/ AskFails \/ SomeoneActs \/ Finished
Spec == Init /\ [][Next]_vars

\* ---- rules: each is a bug the runner's writes could have ----
NoSpin == ~spun           \* the lead never restarts without an event
OneAskPerWait == ~dup     \* one wait for Alex, one runner ask comment
\* NoDeadlock (built in): an open ticket always has someone who moves it.
====
