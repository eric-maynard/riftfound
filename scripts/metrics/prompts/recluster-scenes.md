# Prompt: re-cluster the Riftbound scenes

A ready-to-use brief for a human or an agent driving a scene re-clustering. Read
it top to bottom before running anything; the gates are the point, not the
command.

Background and the measurements behind every threshold here are in
[scraper/CLAUDE.md](../../../scraper/CLAUDE.md) under "Scenes: the persisted
answer to 'which store belongs to which scene'". The runbook form of this is in
[../README.md](../README.md), "Re-clustering scenes".

---

## The brief

> Re-cluster the Riftbound scene assignment on production.
>
> A scene is a Louvain community of the co-play graph projected onto stores: one
> store belongs to one scene, a scene has a ranking, an event happens at a
> store. The assignment is **persisted** and read by every rating refit — it is
> deliberately *not* recomputed each refit, because a refitted partition moves
> 12–18% of its labels and a scene selector that reshuffles daily is unusable.
> So this is an occasional, deliberate operation, and the bar for accepting a
> new assignment is high.
>
> Run `scripts/metrics/scene-recluster.sh` and decide, on the diff, whether to
> accept. Do not accept anything that trips a stop condition. Do not change the
> resolution unless you have been asked to. Report what moved.

## Procedure

1. **See what is live.**

   ```bash
   cd scripts/metrics
   ./scene-recluster.sh --remote --show
   ```

   Note the venue count, the scene count, when it was made, and whether a
   rollback is available. If nothing is stored, this is a first run and there is
   no diff to judge — every scene is new by definition, and the only checks that
   apply are modularity and purity.

2. **Propose, and read the diff.** This writes nothing.

   ```bash
   ./scene-recluster.sh --remote
   ```

3. **Apply the gates.** Accept only if *all* of these hold:

   | gate | accept |
   |---|---|
   | venue churn | under ~10% (the CLI cautions over 10%, says STOP over 25%) |
   | scene ids carried over | at least 70% of the live scene count |
   | the moved stores | boundary stores, not whole cities. Understand every **high-purity** mover before accepting — a store moving at high purity means the clustering changed its mind, not that it was a close call |
   | median venue purity | stays high; 99.3% is the measured reference |
   | stores per scene | **3 or more**. A scene pools several stores; fewer means the graph is fragmented, not that the scenes are fine-grained |
   | modularity | above ~0.3, and **not** above ~0.95 alongside a low stores-per-scene — that pair is a fragmented graph |
   | resolution | unchanged from the live assignment unless a change was asked for |

   Stop conditions, any one of which means **do not write**:

   - churn over 25%, or most scene ids retired → this is a re-partition, not a
     refresh. Usual cause: a new event tier entered the window, or someone
     changed `--resolution`. Re-run at the default resolution first.
   - modularity under 0.3 → there is no scene structure in the graph yet,
     usually because coverage is too low.
   - one scene holding most of the venues → a largest community of 11–17% was
     invariant across every coverage level measured. 60% means something is
     wrong with the graph.
   - hundreds of scenes holding two stores each → the failure the first
     production dry run hit (2,149 venues, 1,042 scenes, modularity 0.9844,
     against a complete region's 390 venues in 51 communities at 0.83). The
     results backfill had not captured the cross-venue edges yet. Wait for
     coverage.
   - median purity falling sharply → stores are being split across scenes, so
     the one-store-one-scene claim is weakening.

4. **Accept, if the gates pass.**

   ```bash
   ./scene-recluster.sh --remote --write
   ```

   Writing changes nothing a reader sees immediately: the scene fields on the
   stored items are rewritten by the next rating refit (up to
   `RANKING_REFIT_INTERVAL_HOURS`, default 24 hours).

5. **Report.** State the venue churn, the number of ids carried, created and
   retired, the median purity before and after, and the high-purity movers by
   name. If you did not write, say which gate stopped you.

## Rolling back

```bash
./scene-recluster.sh --remote --rollback --write
```

One level of undo only: each write keeps the assignment it replaced, and a
second write replaces that predecessor. **Roll back before re-clustering again**
if you are unsure about the assignment you just wrote.

## Things not to do

- **Do not put this on a schedule.** The whole value of a persisted assignment
  is that scenes do not move between deliberate re-clusterings.
- **Do not tune `--resolution` to improve modularity.** gamma = 1 is the measured
  stability optimum (12.1% churn, against 19.7% at 0.5 and 21.8% at 2).
  Modularity rises as you fragment the graph; stability is the quantity that
  matters for a label a reader sees.
- **Do not accept on modularity alone.** A partition can have excellent
  modularity and rename every scene. The diff is the gate.
- **Do not touch `componentId`.** It means a connected component and it is doing
  statistical work — `crossComponentUncertainty` is only valid for one. Scenes
  are an addition, not a rename.
- **Do not re-cluster to fix a single store.** Check its purity first
  (`./ranking-metrics.sh venues --remote`); a store with low purity is genuinely
  split, and re-clustering the whole map will not settle it.
