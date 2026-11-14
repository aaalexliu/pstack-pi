---- MODULE Runner ----
\* One ticket under the runner, reconciled from sources of truth only:
\* Linear (ticket, Decision issue), GitHub (PR), tmux (live lead), and the
\* worktree's .runner/turn-N/ folders (input, ending). The runner keeps no
\* memory, so a crash between any two steps is just a pause.
EXTENDS Naturals
CONSTANTS TWO_STEP_DECISION, MaxTurns

VARIABLES tstate, tmux, turnN, turnSt, turnSrc, turnEnd,
          prs, merged, rounds, mustfix, reviewedTurn, judge,
          decFor, decLinkedFor, decSt, answeredFor, dupDecision

vars == <<tstate, tmux, turnN, turnSt, turnSrc, turnEnd, prs, merged, rounds,
          mustfix, reviewedTurn, judge, decFor, decLinkedFor, decSt, answeredFor, dupDecision>>

Init == /\ tstate = "todo" /\ tmux = FALSE
        /\ turnN = 0 /\ turnSt = "none" /\ turnSrc = "none" /\ turnEnd = "none"
        /\ prs = 0 /\ merged = FALSE /\ rounds = 0 /\ mustfix = FALSE /\ reviewedTurn = 0
        /\ judge = "none" /\ decFor = 0 /\ decLinkedFor = 0 /\ decSt = "none"
        /\ answeredFor = 0 /\ dupDecision = FALSE

\* A new turn folder appears in one rename; the older one counts as consumed.
NewTurn(src) == /\ turnN' = turnN + 1 /\ turnSt' = "pending" /\ turnSrc' = src /\ turnEnd' = "none"

Found(n) == IF TWO_STEP_DECISION THEN decLinkedFor = n ELSE decFor = n
Ended(e) == turnSt = "ended" /\ turnEnd = e
Reviewed == reviewedTurn = turnN

RunnerTakesTicket == tstate = "todo" /\ tstate' = "prog"
    /\ UNCHANGED <<tmux, turnN, turnSt, turnSrc, turnEnd, prs, merged, rounds, mustfix, reviewedTurn, judge, decFor, decLinkedFor, decSt, answeredFor, dupDecision>>

RunnerWritesTask == tstate = "prog" /\ turnN = 0 /\ NewTurn("task")
    /\ UNCHANGED <<tstate, tmux, prs, merged, rounds, mustfix, reviewedTurn, judge, decFor, decLinkedFor, decSt, answeredFor, dupDecision>>

RunnerLaunchesLead == tstate = "prog" /\ ~tmux /\ turnSt = "pending" /\ tmux' = TRUE
    /\ UNCHANGED <<tstate, turnN, turnSt, turnSrc, turnEnd, prs, merged, rounds, mustfix, reviewedTurn, judge, decFor, decLinkedFor, decSt, answeredFor, dupDecision>>

LeadEnds(e) == tmux /\ turnSt = "pending" /\ tmux' = FALSE /\ turnSt' = "ended" /\ turnEnd' = e
    /\ UNCHANGED <<tstate, turnN, turnSrc, prs, merged, rounds, mustfix, reviewedTurn, judge, decFor, decLinkedFor, decSt, answeredFor, dupDecision>>

LeadDies == tmux /\ tmux' = FALSE
    /\ UNCHANGED <<tstate, turnN, turnSt, turnSrc, turnEnd, prs, merged, rounds, mustfix, reviewedTurn, judge, decFor, decLinkedFor, decSt, answeredFor, dupDecision>>

RunnerPostsReport == tstate = "prog" /\ Ended("report") /\ tstate' = "done"
    /\ UNCHANGED <<tmux, turnN, turnSt, turnSrc, turnEnd, prs, merged, rounds, mustfix, reviewedTurn, judge, decFor, decLinkedFor, decSt, answeredFor, dupDecision>>

RunnerOpensPR == tstate = "prog" /\ Ended("change") /\ prs = 0 /\ prs' = 1
    /\ UNCHANGED <<tstate, tmux, turnN, turnSt, turnSrc, turnEnd, merged, rounds, mustfix, reviewedTurn, judge, decFor, decLinkedFor, decSt, answeredFor, dupDecision>>

RunnerReviews == tstate = "prog" /\ Ended("change") /\ prs > 0 /\ ~merged /\ ~Reviewed
    /\ rounds' = rounds + 1 /\ reviewedTurn' = turnN /\ mustfix' \in BOOLEAN
    /\ UNCHANGED <<tstate, tmux, turnN, turnSt, turnSrc, turnEnd, prs, merged, judge, decFor, decLinkedFor, decSt, answeredFor, dupDecision>>

RunnerMerges == tstate = "prog" /\ Ended("change") /\ Reviewed /\ ~mustfix /\ prs > 0 /\ ~merged /\ merged' = TRUE
    /\ UNCHANGED <<tstate, tmux, turnN, turnSt, turnSrc, turnEnd, prs, rounds, mustfix, reviewedTurn, judge, decFor, decLinkedFor, decSt, answeredFor, dupDecision>>

RunnerClosesMerged == tstate = "prog" /\ merged /\ tstate' = "done"
    /\ UNCHANGED <<tmux, turnN, turnSt, turnSrc, turnEnd, prs, merged, rounds, mustfix, reviewedTurn, judge, decFor, decLinkedFor, decSt, answeredFor, dupDecision>>

RunnerSendsFindings == tstate = "prog" /\ Ended("change") /\ Reviewed /\ mustfix /\ rounds < 3 /\ NewTurn("findings")
    /\ UNCHANGED <<tstate, tmux, prs, merged, rounds, mustfix, reviewedTurn, judge, decFor, decLinkedFor, decSt, answeredFor, dupDecision>>

JudgeDecides == tstate = "prog" /\ Ended("change") /\ Reviewed /\ mustfix /\ rounds = 3 /\ judge = "none"
    /\ judge' \in {"cut", "ask"}
    /\ UNCHANGED <<tstate, tmux, turnN, turnSt, turnSrc, turnEnd, prs, merged, rounds, mustfix, reviewedTurn, decFor, decLinkedFor, decSt, answeredFor, dupDecision>>

RunnerSendsCut == tstate = "prog" /\ Ended("change") /\ Reviewed /\ mustfix /\ rounds = 3 /\ judge = "cut" /\ NewTurn("cut")
    /\ UNCHANGED <<tstate, tmux, prs, merged, rounds, mustfix, reviewedTurn, judge, decFor, decLinkedFor, decSt, answeredFor, dupDecision>>

CutStillFails == tstate = "prog" /\ Ended("change") /\ Reviewed /\ mustfix /\ rounds = 4 /\ judge = "cut" /\ judge' = "ask"
    /\ UNCHANGED <<tstate, tmux, turnN, turnSt, turnSrc, turnEnd, prs, merged, rounds, mustfix, reviewedTurn, decFor, decLinkedFor, decSt, answeredFor, dupDecision>>

NeedAsk == turnSt = "ended" /\ (turnEnd = "decision" \/ (turnEnd = "change" /\ Reviewed /\ mustfix /\ judge = "ask"))

RunnerFilesDecision == tstate = "prog" /\ NeedAsk /\ ~Found(turnN)
    /\ dupDecision' = (dupDecision \/ decFor = turnN)
    /\ decFor' = turnN /\ decSt' = "open"
    /\ decLinkedFor' = (IF TWO_STEP_DECISION THEN decLinkedFor ELSE turnN)
    /\ UNCHANGED <<tstate, tmux, turnN, turnSt, turnSrc, turnEnd, prs, merged, rounds, mustfix, reviewedTurn, judge, answeredFor>>

RunnerLinksDecision == TWO_STEP_DECISION /\ decFor # 0 /\ decLinkedFor # decFor /\ decLinkedFor' = decFor
    /\ UNCHANGED <<tstate, tmux, turnN, turnSt, turnSrc, turnEnd, prs, merged, rounds, mustfix, reviewedTurn, judge, decFor, decSt, answeredFor, dupDecision>>

AlexAnswers == decSt = "open" /\ decSt' = "answered"
    /\ UNCHANGED <<tstate, tmux, turnN, turnSt, turnSrc, turnEnd, prs, merged, rounds, mustfix, reviewedTurn, judge, decFor, decLinkedFor, answeredFor, dupDecision>>

AlexCancels == decSt = "open" /\ decSt' = "canceled"
    /\ UNCHANGED <<tstate, tmux, turnN, turnSt, turnSrc, turnEnd, prs, merged, rounds, mustfix, reviewedTurn, judge, decFor, decLinkedFor, answeredFor, dupDecision>>

RunnerResumesWithAnswer == tstate = "prog" /\ decSt = "answered" /\ decFor = turnN /\ Found(turnN)
    /\ answeredFor # decFor /\ answeredFor' = decFor /\ NewTurn("answer")
    /\ rounds' = 0 /\ judge' = "none"
    /\ UNCHANGED <<tstate, tmux, prs, merged, mustfix, reviewedTurn, decFor, decLinkedFor, decSt, dupDecision>>

RunnerClosesCanceled == tstate = "prog" /\ decSt = "canceled" /\ decFor = turnN /\ Found(turnN) /\ tstate' = "done"
    /\ UNCHANGED <<tmux, turnN, turnSt, turnSrc, turnEnd, prs, merged, rounds, mustfix, reviewedTurn, judge, decFor, decLinkedFor, decSt, answeredFor, dupDecision>>

Finished == tstate = "done" /\ UNCHANGED vars

Next == RunnerTakesTicket \/ RunnerWritesTask \/ RunnerLaunchesLead
     \/ LeadEnds("report") \/ LeadEnds("change") \/ LeadEnds("decision") \/ LeadDies
     \/ RunnerPostsReport \/ RunnerOpensPR \/ RunnerReviews \/ RunnerMerges \/ RunnerClosesMerged
     \/ RunnerSendsFindings \/ JudgeDecides \/ RunnerSendsCut \/ CutStillFails
     \/ RunnerFilesDecision \/ RunnerLinksDecision \/ AlexAnswers \/ AlexCancels
     \/ RunnerResumesWithAnswer \/ RunnerClosesCanceled \/ Finished

Spec == Init /\ [][Next]_vars

\* Rules
NoMergeOverMustFix == merged => (~mustfix /\ Reviewed)
OnePR == prs <= 1
OneDecisionPerAsk == ~dupDecision
NoReplayedTurn == tmux => turnSt = "pending"
AnswerReachesLead == (tstate = "done" /\ decSt = "answered") => answeredFor = decFor
TurnBound == turnN <= MaxTurns
====
