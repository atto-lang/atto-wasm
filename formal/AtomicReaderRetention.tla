--------------------- MODULE AtomicReaderRetention ---------------------
EXTENDS FiniteSets, TLC

\* A proposed reader-pinning + retire-before-reclaim protocol; this is
\* a normative safety model, NOT a GC implementation or a proof of liveness.
\* A release identity denotes complete, verified, immutable bytes. Pins are
\* persistently recorded across abrupt process termination; forgotten crash
\* pins leak storage rather than cause use-after-free.
CONSTANTS Releases, Readers, None, Unsafe
ASSUME /\ Releases # {}
       /\ Readers # {}
       /\ None \notin Releases
       /\ Unsafe \in BOOLEAN

VARIABLES installed, current, pins, retired, crashed
vars == <<installed, current, pins, retired, crashed>>

Init ==
 /\ installed = {}
 /\ current = None
 /\ pins = [r \in Readers |-> None]
 /\ retired = {}
 /\ crashed = FALSE

Install(x) ==
 /\ ~crashed
 /\ x \in Releases \ installed
 /\ installed' = installed \cup {x}
 /\ UNCHANGED <<current,pins,retired,crashed>>

Publish(x) ==
 /\ ~crashed
 /\ x \in installed
 /\ x \notin retired
 /\ current' = x
 /\ UNCHANGED <<installed,pins,retired,crashed>>

\* Pin acquisition must be serialized with retirement authorization. A
\* standalone "read pointer; later publish pin" protocol is NOT sufficient.
PinCurrent(r) ==
 /\ ~crashed
 /\ pins[r] = None
 /\ current # None
 /\ current \notin retired
 /\ pins' = [pins EXCEPT ![r] = current]
 /\ UNCHANGED <<installed,current,retired,crashed>>

ReleasePin(r) ==
 /\ ~crashed
 /\ pins[r] # None
 /\ pins' = [pins EXCEPT ![r] = None]
 /\ UNCHANGED <<installed,current,retired,crashed>>

\* Retirement closes admission to this identity before the collector
\* waits for previously acquired persistent pins to drain.
Retire(x) ==
 /\ ~crashed
 /\ x \in installed
 /\ x # current
 /\ x \notin retired
 /\ retired' = retired \cup {x}
 /\ UNCHANGED <<installed,current,pins,crashed>>

Reclaim(x) ==
 /\ ~crashed
 /\ x \in retired
 /\ x \in installed
 /\ x # current
 /\ \A r \in Readers: pins[r] # x
 /\ installed' = installed \ {x}
 /\ retired' = retired \ {x}
 /\ UNCHANGED <<current,pins,crashed>>

\* A restart never silently revokes persistent pin authority. If an owner
\* is permanently dead, a separate authenticated owner-fencing protocol
\* would be required before reclaim; not modeled and not implemented.
Crash ==
 /\ ~crashed
 /\ crashed' = TRUE
 /\ UNCHANGED <<installed,current,pins,retired>>

Recover ==
 /\ crashed
 /\ crashed' = FALSE
 /\ UNCHANGED <<installed,current,pins,retired>>

\* Negative control: reclaiming a retired identity despite an existing pin.
UnsafeReclaim(x) ==
 /\ Unsafe
 /\ ~crashed
 /\ x \in retired
 /\ x \in installed
 /\ x # current
 /\ \E r \in Readers: pins[r] = x
 /\ installed' = installed \ {x}
 /\ retired' = retired \ {x}
 /\ UNCHANGED <<current,pins,crashed>>

Next ==
 \/ \E x \in Releases:
        Install(x) \/ Publish(x) \/ Retire(x) \/ Reclaim(x)
        \/ UnsafeReclaim(x)
 \/ \E r \in Readers: PinCurrent(r) \/ ReleasePin(r)
 \/ Crash \/ Recover

Spec == Init /\ [][Next]_vars

TypeOK ==
 /\ installed \subseteq Releases
 /\ retired \subseteq installed
 /\ current \in Releases \cup {None}
 /\ pins \in [Readers -> Releases \cup {None}]
 /\ crashed \in BOOLEAN

CurrentPresent == current = None \/ current \in installed
PinnedPresent == \A r \in Readers: pins[r] = None \/ pins[r] \in installed
RetirementClosesAdmission == current \notin retired
=============================================================================
