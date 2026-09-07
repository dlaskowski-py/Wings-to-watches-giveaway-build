# Wings to Watches — quarterly giveaway system

Imports the CSVs you export from Venmo and Zelle, lets you check every payment
before anything counts, and runs a drawing that any member of the group can
verify for themselves afterwards.

- **Operator console:** https://wings-to-watches-giveaway.netlify.app
- **Public verification:** `https://wings-to-watches-giveaway.netlify.app/verify/<drawing-id>`

---

## Signing in

One shared passcode. No email, no magic link, no account to set up:

> **Passcode:** `beacon-harbor-zephyr-6337`

**Change it now that you have it**, in the Supabase dashboard →
[Authentication → Users](https://supabase.com/dashboard/project/eutanvevhbyntjkdpueu/auth/users)
→ `console@wings-to-watches.app` → **Reset password**. It takes effect
immediately.

### How it actually works, and why it is not just a browser check

The passcode is **not** validated in the browser. It could not be: the
publishable Supabase key ships inside the JavaScript bundle, so anyone could
skip the interface entirely and query the API directly for every member's name,
email, phone number and payment amount. A passcode the frontend checks by itself
would be decoration.

Instead the passcode is the *password* of one fixed Supabase account
(`console@wings-to-watches.app` — a fixed identifier, not a secret, and nothing
is ever emailed to it). Signing in exchanges the passcode for a real token, and
Row Level Security does the enforcement in the database. Knowing the publishable
key gets an attacker nothing without the passcode, and Supabase rate-limits
guesses.

Because everyone shares one passcode, the audit log records actions as "the
console" rather than naming a person. If you later want each helper attributed
individually, that is a small change — say the word.

---

## How a quarter works---

## How a quarter works

1. **Create the drawing.** Name, price per entry ($25), how many winners, how
   many alternates, and the payment window.

2. **Import your CSVs.** Upload the Venmo export and each Zelle/checking export.
   The app finds the real header row, guesses what each column means, and shows
   you the first 20 rows *as it will read them*. Nothing is saved until you
   confirm the summary.

3. **Review everything.** This is the screen the whole thing exists for. Every
   payment is listed with its computed entries. Work through the flags, approve
   or exclude each row, and check the reconciliation panel ties out against what
   actually hit your account. Export to Excel or CSV at any point.

4. **Merge duplicate people.** Somebody who paid by Venmo as `@dan-l` and by
   Zelle as `DANIEL LASKOWSKI` should be one entrant, not two. Exact matches
   merge automatically; anything less certain is a suggestion you approve.

5. **Lock.** Freezes the entrant list and publishes three values plus a future
   drand round number. **Post these to the group before the round lands** — that
   is what makes the result credible.

6. **Draw.** Once the committed drand round is published, one click picks the
   winners and reveals the seed. It cannot be run twice.

7. **Share the verification link.** Anyone can open it and re-run the draw in
   their own browser.

---

## Why the group can trust the draw

The person most able to rig this is the operator. Everything below exists to
make that impossible rather than merely unlikely.

**A secret seed alone is not enough.** If we only committed to `hash(seed)`, a
dishonest operator could generate a thousand seeds privately, run the draw a
thousand times, and publish only the seed where their friend wins. Every number
would check out. The scheme would be worthless.

So the final seed also mixes in **public randomness that did not exist yet when
the commitment was made**:

| At lock time (published)          | After the beacon lands            |
|-----------------------------------|-----------------------------------|
| SHA-256 of the frozen entrant list | The drand round's random value    |
| SHA-256 of the secret seed        | The secret seed itself, revealed  |
| A future **drand** round number   | The winners                       |

[drand](https://drand.love) is a public randomness network run by Cloudflare,
EPFL, Protocol Labs and others. It publishes an unpredictable value every three
seconds, and past values stay public forever. Because the operator must commit
*before* that value exists, they cannot grind seeds; because the entrant list
was hashed first, they cannot swap it; and because anyone can re-fetch the round
from drand, they cannot fake it.

Other properties:

- The secret seed is written where **even the signed-in operator cannot read
  it** — a table with RLS on and no policies, reachable only by the Edge
  Function's service-role key. So the outcome cannot be privately simulated
  before it is committed.
- Selection is weighted by tickets, uses rejection sampling to eliminate modulo
  bias, and removes all of a winner's tickets so nobody wins twice.
- Alternates are drawn in the same pass and published up front, so replacing an
  unreachable winner does not need a fresh private draw.
- Once drawn, the database blocks edits to the results, the seed, the entrant
  list, the payments and the audit log — enforced by triggers, not by convention.

---

## Running it locally

```bash
cp .env.example .env.local     # fill in the two Supabase values
npm install
npm run dev
```

| Command | What it does |
|---|---|
| `npm run dev` | Local dev server |
| `npm run build` | Checks the draw core is in sync, typechecks, builds, and scans the bundle for secrets |
| `npm test` | 121 unit tests |
| `npm run check:rls` | Hits the live API with the public key; everything must come back denied |
| `npm run check:bundle` | Fails if a service-role key ever reaches `dist/` |

### Giving someone access

Share the passcode. To revoke it, change the password on
`console@wings-to-watches.app` in the Supabase dashboard — everyone is signed
out at their next token refresh.

Access is ultimately controlled by the `admin_emails` table, not the interface.
The console account has a row there; an account without one can read nothing at
all, whatever the interface shows.

### Deploying

The Netlify site builds from this repo. Two environment variables are set in
Netlify (both safe to be public — Row Level Security is what protects the data):

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

The **service-role key must never appear in this repo or the frontend.** It
lives only in the Supabase Edge Function environment, and `npm run build` fails
if one ever reaches the bundle.

Database changes live in `supabase/migrations/` and are applied in order. The
Edge Function is in `supabase/functions/drawing-actions/`; deploy it with
`supabase functions deploy drawing-actions`.

---

## How the code is laid out

```
src/lib/draw/core.ts     The draw: canonical serialisation, CSPRNG, unbiased
                         sampling, winner selection, verification. Zero imports
                         so the identical file runs in the Edge Function, the
                         browser verifier and the tests.
src/lib/draw/beacon.ts   drand client.
src/lib/csv/             Amount and date parsing (integer cents, never floats),
                         header/column detection, identity matching, dedupe.
src/routes/              The console, plus the public /verify page.
supabase/migrations/     Schema, RLS, and the immutability triggers.
supabase/functions/      The privileged lock and draw operations.
scripts/probe-rls.sh     Adversarial check that nothing leaks to anonymous users.
scripts/check-bundle.sh  Adversarial check that no secret reaches the browser.
```

`src/lib/draw/core.ts` is copied verbatim into the Edge Function directory by
`scripts/sync-draw-core.mjs`, and a test fails the build if the two ever drift.
If the verifier could run different code than the drawer, the whole exercise
would be theatre.

---

## Things worth knowing

- **Money is stored in integer cents.** `parseFloat("0.29") * 100` is
  `28.999999999999996`; nothing here goes near a float.
- **Dates keep the calendar date the export actually wrote.** Round-tripping an
  8pm-Eastern payment through UTC would move it to the next day and could push
  it outside the payment window.
- **Nothing is silently dropped.** A row the importer cannot fully understand
  still arrives, carrying a flag that says what is wrong, so it lands in front
  of you instead of vanishing.
- **$60 becomes 2 entries and a flagged $10.** You decide what happens to the
  remainder — including gifting the third entry by typing over the entry count.
- **Re-importing an overlapping export is safe.** Duplicates are detected by
  transaction ID where the export has one, or by a content hash otherwise, and
  are parked rather than counted. If somebody genuinely paid twice on the same
  day for the same amount, you can approve the second one.
- **Notes are treated as hostile on export.** A payer can type `=cmd|...` into a
  Venmo note; it is neutralised so Excel will not execute it when you open the
  file.
- **Raffle and sweepstakes rules vary by state**, and paid entry can change what
  applies. Worth a look before your next quarter — this system keeps a complete
  exportable record, which is the part it can help with.
