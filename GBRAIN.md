Setting up local brain with PGLite (no server needed)...

Brain ready at /home/mjscully/.gbrain/brain.pglite
0 pages. Engine: PGLite (local Postgres).
Next: gbrain import <dir>

When you outgrow local: gbrain migrate --to supabase

--- GBrain Mod Status ---
Skills: 43 loaded
GStack: not found
  Install GStack for coding skills:
  git clone https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
  cd ~/.claude/skills/gstack && ./setup
Resolver: skills/RESOLVER.md
Soul audit: run `gbrain soul-audit` to customize agent identity


========================================================================
gbrain 0.37.3.0 — RECOMMENDED SKILLS FOR THE AGENT TO INSTALL
========================================================================

The user just installed gbrain 0.37.3.0. This release ships 9 skills that the user should consider installing into their workspace.

(NOTE: No OpenClaw workspace was detected at the default location. Set $OPENCLAW_WORKSPACE or pass --skills-dir to gbrain skillpack install.)

THE NEW SKILLS:

  - book-mirror
      FLAGSHIP. Take any book (EPUB/PDF), produce a personalized
      two-column chapter-by-chapter analysis. Left column preserves the
      chapter; right column maps every idea to your life using brain
      context. ~$6 for a 20-chapter book at Opus.

  - article-enrichment
      Turn raw article dumps into structured pages with executive summary,
      verbatim quotes, key insights, why-it-matters.

  - strategic-reading
      Read a book / article / case study through ONE specific
      problem-lens. Output: applied playbook with do / avoid / watch-for.

  - concept-synthesis
      Deduplicate raw concept stubs into a tiered intellectual map (T1
      Canon to T4 Riff). Trace idea evolution across years.

  - perplexity-research
      Brain-augmented web research. Sends brain context to Perplexity so
      the search focuses on what is NEW vs already-known.

  - archive-crawler
      Universal archivist for personal file archives (Dropbox / B2 /
      Gmail-takeout). REFUSES to run without a gbrain.yml allow-list —
      safe-by-default.

  - academic-verify
      Trace a research claim through publication → methodology → raw data
      → independent replication. Verdict-shaped brain page.

  - brain-pdf
      Render any brain page to publication-quality PDF via the gstack
      make-pdf binary. Optional gstack co-install.

  - voice-note-ingest
      Capture voice notes with EXACT-PHRASING preservation (never
      paraphrased). Routes content to
      originals/concepts/people/companies/ideas.

ACTION FOR THE AGENT:

  1. Show this list to the user. Briefly explain each skill.
  2. Ask the user explicitly: "Want me to install these now?"
  3. If YES, run this command:

         gbrain skillpack install --all

  4. If NO, tell them they can install any time with:

         gbrain skillpack install <name>      # one skill
         gbrain skillpack install --all       # all bundled
         gbrain skillpack list                # see all options

  Do NOT install without asking. The user owns this decision.
========================================================================

