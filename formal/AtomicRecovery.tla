------------------------- MODULE AtomicRecovery -------------------------
EXTENDS FiniteSets, TLC
\* Bounded logical durability model. A release is durable only after its
\* directory and file contents have crossed the required fsync barriers.
\* Crash preserves durable releases and a pointer which survived fsync.
CONSTANTS Releases, Readers, None, Unsafe
ASSUME /\ Releases # {}
       /\ Readers # {}
       /\ None \notin Releases
       /\ Unsafe \in BOOLEAN

VARIABLES durable, pointer, pinned, crashed
vars == <<durable,pointer,pinned,crashed>>

Init == /\ durable = {}
        /\ pointer = None
        /\ pinned = [r \in Readers |-> None]
        /\ crashed = FALSE

Install(x) ==
 /\ ~crashed /\ x \in Releases \ durable
 /\ durable' = durable \cup {x}
 /\ UNCHANGED <<pointer,pinned,crashed>>

Publish(x) ==
 /\ ~crashed /\ x \in durable
 /\ pointer' = x
 /\ UNCHANGED <<durable,pinned,crashed>>

StartRead(r) ==
 /\ ~crashed /\ pinned[r] = None /\ pointer # None
 /\ pinned' = [pinned EXCEPT ![r] = pointer]
 /\ UNCHANGED <<durable,pointer,crashed>>

FinishRead(r) ==
 /\ pinned[r] # None
 /\ pinned' = [pinned EXCEPT ![r] = None]
 /\ UNCHANGED <<durable,pointer,crashed>>

Crash ==
 /\ ~crashed
 /\ crashed' = TRUE
 /\ UNCHANGED <<durable,pointer,pinned>>

Recover ==
 /\ crashed
 /\ crashed' = FALSE
 /\ UNCHANGED <<durable,pointer,pinned>>

SafeCollect(x) ==
 /\ ~crashed /\ x \in durable /\ x # pointer
 /\ \A r \in Readers: pinned[r] # x
 /\ durable' = durable \ {x}
 /\ UNCHANGED <<pointer,pinned,crashed>>

\* Counterexample: deleting an older release held by an active reader.
UnsafeCollect(x) ==
 /\ Unsafe /\ ~crashed /\ x \in durable /\ x # pointer
 /\ \E r \in Readers: pinned[r] = x
 /\ durable' = durable \ {x}
 /\ UNCHANGED <<pointer,pinned,crashed>>

Next ==
 \/ \E x \in Releases: Install(x) \/ Publish(x) \/ SafeCollect(x)
                     \/ UnsafeCollect(x)
 \/ \E r \in Readers: StartRead(r) \/ FinishRead(r)
 \/ Crash \/ Recover

Spec == Init /\ [][Next]_vars
TypeOK ==
 /\ durable \subseteq Releases
 /\ pointer \in Releases \cup {None}
 /\ pinned \in [Readers -> Releases \cup {None}]
 /\ crashed \in BOOLEAN

PointerAlwaysInstalled == pointer = None \/ pointer \in durable
ReaderPinnedReleasePresent ==
 \A r \in Readers: pinned[r] = None \/ pinned[r] \in durable
=============================================================================
