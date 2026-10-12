---------------------- MODULE AtomicCommitOutcome ----------------------
EXTENDS FiniteSets, TLC
\* Bounded abstraction of two serialized release publishers, not a proof
\* that the JavaScript/fsync implementation is correct on physical media.
\* Pointer rename changes VISIBILITY; parent fsync confirms DURABILITY.
\* Failure after rename is UNCERTAIN and must not cause blind replay.
CONSTANTS Releases, None, Unsafe
ASSUME /\ Releases # {}
       /\ None \notin Releases
       /\ Unsafe \in BOOLEAN

VARIABLES installed, pointer, stable, phase, owner, crashed, blindReplay
vars == <<installed,pointer,stable,phase,owner,crashed,blindReplay>>

States == {"idle","staging","sealed","renamed","uncertain",
           "confirmed","aborted","inspected"}

Init == /\ installed = {}
        /\ pointer = None
        /\ stable = None
        /\ phase = [r \in Releases |-> "idle"]
        /\ owner = None
        /\ crashed = FALSE
        /\ blindReplay = FALSE

Start(r) ==
 /\ ~crashed /\ owner = None /\ phase[r] = "idle"
 /\ owner' = r
 /\ phase' = [phase EXCEPT ![r] = "staging"]
 /\ UNCHANGED <<installed,pointer,stable,crashed,blindReplay>>

Install(r) ==
 /\ ~crashed /\ owner = r /\ phase[r] = "staging"
 /\ installed' = installed \cup {r}
 /\ phase' = [phase EXCEPT ![r] = "sealed"]
 /\ UNCHANGED <<pointer,stable,owner,crashed,blindReplay>>

AbortBeforeRename(r) ==
 /\ ~crashed /\ owner = r /\ phase[r] = "sealed"
 /\ phase' = [phase EXCEPT ![r] = "aborted"]
 /\ owner' = None
 /\ UNCHANGED <<installed,pointer,stable,crashed,blindReplay>>

RenamePointer(r) ==
 /\ ~crashed /\ owner = r /\ phase[r] = "sealed"
 /\ pointer' = r
 /\ phase' = [phase EXCEPT ![r] = "renamed"]
 /\ UNCHANGED <<installed,stable,owner,crashed,blindReplay>>

DirectorySyncOK(r) ==
 /\ ~crashed /\ owner = r /\ phase[r] = "renamed"
 /\ stable' = pointer
 /\ owner' = None
 /\ phase' = [phase EXCEPT ![r] = "confirmed"]
 /\ UNCHANGED <<installed,pointer,crashed,blindReplay>>

DirectorySyncFailed(r) ==
 /\ ~crashed /\ owner = r /\ phase[r] = "renamed"
 /\ phase' = [phase EXCEPT ![r] = "uncertain"]
 /\ owner' = None
 /\ UNCHANGED <<installed,pointer,stable,crashed,blindReplay>>

\* Read-only reconciliation identifies visibility, NOT external effects,
\* so it has no automatic retry or replay transition.
InspectUncertain(r) ==
 /\ ~crashed /\ phase[r] = "uncertain"
 /\ phase' = [phase EXCEPT ![r] = "inspected"]
 /\ UNCHANGED <<installed,pointer,stable,owner,crashed,blindReplay>>

\* An unsuccessful directory fsync leaves two crash outcomes possible:
\* the new pointer survived storage OR only the previous stable pointer did.
CrashLoseRecent ==
 /\ ~crashed
 /\ crashed' = TRUE
 /\ pointer' = stable
 /\ owner' = None
 /\ UNCHANGED <<installed,stable,phase,blindReplay>>

CrashKeepRecent ==
 /\ ~crashed /\ pointer # stable
 /\ crashed' = TRUE
 /\ stable' = pointer
 /\ owner' = None
 /\ UNCHANGED <<installed,pointer,phase,blindReplay>>

Recover ==
 /\ crashed
 /\ crashed' = FALSE
 /\ UNCHANGED <<installed,pointer,stable,phase,owner,blindReplay>>

\* Unsafe regression intentionally permits retrying a non-idempotent effect
\* based only on the uncertain exception; NoBlindReplay must detect it.
UnsafeBlindRetry(r) ==
 /\ Unsafe /\ ~crashed /\ phase[r] = "uncertain"
 /\ blindReplay' = TRUE
 /\ UNCHANGED <<installed,pointer,stable,phase,owner,crashed>>

Next ==
 \/ \E r \in Releases:
      Start(r) \/ Install(r) \/ AbortBeforeRename(r) \/ RenamePointer(r)
      \/ DirectorySyncOK(r) \/ DirectorySyncFailed(r)
      \/ InspectUncertain(r) \/ UnsafeBlindRetry(r)
 \/ CrashLoseRecent \/ CrashKeepRecent \/ Recover

Spec == Init /\ [][Next]_vars

TypeOK ==
 /\ installed \subseteq Releases
 /\ pointer \in Releases \cup {None}
 /\ stable \in Releases \cup {None}
 /\ phase \in [Releases -> States]
 /\ owner \in Releases \cup {None}
 /\ crashed \in BOOLEAN
 /\ blindReplay \in BOOLEAN

CompletePointers ==
 /\ (pointer = None \/ pointer \in installed)
 /\ (stable = None \/ stable \in installed)

NoFalseAbort ==
 \A r \in Releases: phase[r] = "aborted" => pointer # r

ConfirmedIsInstalled ==
 \A r \in Releases: phase[r] = "confirmed" => r \in installed

NoBlindReplay == ~blindReplay
=============================================================================
