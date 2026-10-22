// Which tap may open the viewer (board #329 for Board; #447 made it the one
// rule for every host). A chat image's viewer URL is signed AFTER the tap, so
// its answer can arrive when the reader has moved on: a different image, a
// different issue or room, the page hidden. Each tap takes a claim, and only
// the answer to the LATEST tap, in the epoch it was made, may open.
//
//   begin()   at the tap, before the signature is asked for.
//   accept()  when the answer arrives: true only for the latest, unretired claim.
//   retire()  the host let go (close, hide, ineligible, another image): every
//             claim taken so far is dead and nothing resurrects one.
//
// `epoch` is the host's own "same place" fact (Board's issue generation, Hub's
// project selection); a claim from another epoch is dead too. It must be a
// COUNTER that only grows: a value that can come back (A, B, A) would revive a
// claim taken the first time.

export interface ViewClaim { epoch: unknown; n: number }

export function createViewClaim(epoch: () => unknown = () => 0) {
  let n = 0;
  return {
    begin(): ViewClaim { return { epoch: epoch(), n: ++n }; },
    accept(claim: ViewClaim | undefined | null): boolean {
      return !!claim && claim.epoch === epoch() && claim.n === n;
    },
    retire(): void { n++; },
  };
}
