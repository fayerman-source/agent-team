---
description: "Append one papercuts.md entry for a tooling or process problem hit just now"
argument-hint: "<symptom> | <fix>"
allowed-tools: ["Bash", "Read", "Edit", "Write"]
---

# /papercut

Record a papercut: a tooling or process problem that cost you time
mid-work. This is not a design decision or a rule change; it is a short
note so nobody has to reconstruct the fix from memory later (rule 22).

**Symptom and fix, if given inline (optional):** "$ARGUMENTS"

## Steps

1. Find the repo root (`git rev-parse --show-toplevel`). `papercuts.md`
   lives there, shared by every session working this repo.
2. If `papercuts.md` doesn't exist yet, create it with a one-line
   header: `# Papercuts` followed by a blank line.
3. Work out the four fields:
   - `date`: today's date, `YYYY-MM-DD`.
   - `symptom`: what went wrong, in a few words.
   - `fix`: what made it work, in a few words.
   - `where`: the file, command, or tool involved.
   Use the argument above for symptom/fix if it was given as
   `<symptom> | <fix>`; otherwise ask, or infer from what you just did
   in this turn.
4. Append one line to `papercuts.md`, in this exact form, and nothing
   else:

```
<date> · <symptom> · <fix> · <where>
```

5. Confirm the line was appended by reading the last line of the file
   back, don't just trust the write.
