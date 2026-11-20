------------------------ MODULE AtomicRelease ------------------------
EXTENDS Naturals, FiniteSets, TLC

\* A bounded state machine for competing builders of content-addressed
\* artifacts. Writers themselves are modeled as unique release digests;
\* cryptographic collision resistance and trusted private storage are
\* assumptions, not conclusions of TLC model checking.
CONSTANTS Writers, NoRelease, Unsafe
ASSUME /\ Writers # {}
       /\ NoRelease \notin Writers
       /\ Unsafe \in BOOLEAN

VARIABLES phase, sealed, installed, pointer
vars == <<phase, sealed, installed, pointer>>

Init == /\ phase = [w \in Writers |-> "idle"]
        /\ sealed = {}
        /\ installed = {}
        /\ pointer = NoRelease

Begin(w) ==
 /\ phase[w] = "idle"
 /\ phase' = [phase EXCEPT ![w] = "staged"]
 /\ UNCHANGED <<sealed, installed, pointer>>

Seal(w) ==
 /\ phase[w] = "staged"
 /\ phase' = [phase EXCEPT ![w] = "verified"]
 /\ sealed' = sealed \cup {w}
 /\ UNCHANGED <<installed, pointer>>

Install(w) ==
 /\ phase[w] = "verified"
 /\ phase' = [phase EXCEPT ![w] = "installed"]
 /\ installed' = installed \cup {w}
 /\ UNCHANGED <<sealed, pointer>>

Publish(w) ==
 /\ phase[w] = "installed"
 /\ w \in installed
 /\ phase' = [phase EXCEPT ![w] = "published"]
 /\ pointer' = w
 /\ UNCHANGED <<sealed, installed>>

Abort(w) ==
 /\ phase[w] \in {"staged", "verified", "installed"}
 /\ phase' = [phase EXCEPT ![w] = "aborted"]
 /\ UNCHANGED <<sealed, installed, pointer>>

\* Deliberately unsafe: a pointer may be advanced before verification.
\* TLC MUST reject the negative-control config.
UnsafePublish(w) ==
 /\ Unsafe
 /\ phase[w] = "staged"
 /\ pointer' = w
 /\ UNCHANGED <<phase, sealed, installed>>

Next == \E w \in Writers:
          Begin(w) \/ Seal(w) \/ Install(w) \/ Publish(w)
          \/ Abort(w) \/ UnsafePublish(w)

Spec == Init /\ [][Next]_vars

TypeOK ==
 /\ phase \in [Writers -> {"idle","staged","verified","installed","published","aborted"}]
 /\ sealed \subseteq Writers
 /\ installed \subseteq Writers
 /\ pointer \in Writers \cup {NoRelease}

NoPartialPointer == pointer = NoRelease \/ pointer \in installed
OnlyVerifiedInstalled == installed \subseteq sealed
PointerVerified == pointer = NoRelease \/ pointer \in sealed

=============================================================================
