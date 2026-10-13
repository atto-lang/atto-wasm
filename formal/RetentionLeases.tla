----------------------- MODULE RetentionLeases -----------------------
EXTENDS FiniteSets, TLC

\* Normative PROPOSED protocol for future GC; current Wasm has NO GC.
\* A lease is an authority-coordinated pin. An unacknowledged reader
\* process crash does NOT release its protection; that pin stays suspect.
\* Pin acquisition + pointer selection must be one linearizable operation
\* against the same GC authority; reading then pinning is NOT safe.
CONSTANTS Releases, Readers, NoRelease, Unsafe
ASSUME /\ Releases # {} /\ Readers # {}
       /\ NoRelease \notin Releases
       /\ Unsafe \in BOOLEAN

VARIABLES installed, current, held, leaseState, writerCrashed
vars == <<installed,current,held,leaseState,writerCrashed>>
LeaseStates == {"free","live","suspect"}

Init == /\ installed = {}
        /\ current = NoRelease
        /\ held = [r \in Readers |-> NoRelease]
        /\ leaseState = [r \in Readers |-> "free"]
        /\ writerCrashed = FALSE

Install(w) ==
 /\ ~writerCrashed /\ w \in Releases \ installed
 /\ installed' = installed \cup {w}
 /\ UNCHANGED <<current,held,leaseState,writerCrashed>>

Publish(w) ==
 /\ ~writerCrashed /\ w \in installed
 /\ current' = w
 /\ UNCHANGED <<installed,held,leaseState,writerCrashed>>

AcquireReader(r) ==
 /\ ~writerCrashed
 /\ leaseState[r] = "free"
 /\ current # NoRelease
 /\ held' = [held EXCEPT ![r] = current]
 /\ leaseState' = [leaseState EXCEPT ![r] = "live"]
 /\ UNCHANGED <<installed,current,writerCrashed>>

FinishReader(r) ==
 /\ leaseState[r] = "live"
 /\ held' = [held EXCEPT ![r] = NoRelease]
 /\ leaseState' = [leaseState EXCEPT ![r] = "free"]
 /\ UNCHANGED <<installed,current,writerCrashed>>

ReaderDisappears(r) ==
 /\ leaseState[r] = "live"
 /\ leaseState' = [leaseState EXCEPT ![r] = "suspect"]
 /\ UNCHANGED <<installed,current,held,writerCrashed>>

\* Fencing/authoritative confirmation is a prerequisite. This abstract
\* transition DOES NOT implement the liveness/fencing proof; until
\* that proof exists, runtime GC must remain OFF.
FencedReaderDeath(r) ==
 /\ leaseState[r] = "suspect"
 /\ held' = [held EXCEPT ![r] = NoRelease]
 /\ leaseState' = [leaseState EXCEPT ![r] = "free"]
 /\ UNCHANGED <<installed,current,writerCrashed>>

CrashWriter ==
 /\ ~writerCrashed
 /\ writerCrashed' = TRUE
 /\ UNCHANGED <<installed,current,held,leaseState>>

RecoverWriter ==
 /\ writerCrashed
 /\ writerCrashed' = FALSE
 /\ UNCHANGED <<installed,current,held,leaseState>>

Collect(w) ==
 /\ ~writerCrashed /\ w \in installed /\ w # current
 /\ \A r \in Readers: held[r] # w
 /\ installed' = installed \ {w}
 /\ UNCHANGED <<current,held,leaseState,writerCrashed>>

\* Unsafe negative control: a timeout *without fencing* treats a suspect
\* reader as dead and collects its release. TLC must reject this action.
UnsafeExpireAndCollect(w) ==
 /\ Unsafe /\ ~writerCrashed
 /\ w \in installed /\ w # current
 /\ \E r \in Readers: held[r] = w /\ leaseState[r] = "suspect"
 /\ installed' = installed \ {w}
 /\ UNCHANGED <<current,held,leaseState,writerCrashed>>

Next ==
 \/ \E w \in Releases:
     Install(w) \/ Publish(w) \/ Collect(w) \/ UnsafeExpireAndCollect(w)
 \/ \E r \in Readers:
     AcquireReader(r) \/ FinishReader(r) \/ ReaderDisappears(r)
       \/ FencedReaderDeath(r)
 \/ CrashWriter \/ RecoverWriter

Spec == Init /\ [][Next]_vars

TypeOK ==
 /\ installed \subseteq Releases
 /\ current \in Releases \cup {NoRelease}
 /\ held \in [Readers -> Releases \cup {NoRelease}]
 /\ leaseState \in [Readers -> LeaseStates]
 /\ writerCrashed \in BOOLEAN

CurrentPresent == current = NoRelease \/ current \in installed
PinnedPresent ==
 \A r \in Readers: held[r] = NoRelease \/ held[r] \in installed
PinStateCoherent ==
 \A r \in Readers:
    (leaseState[r] = "free") <=> (held[r] = NoRelease)

=============================================================================
