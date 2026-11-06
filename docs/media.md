# Why the media extension works the way it does

The media extension (`extensions/media/`) shows the images, videos, and PDFs an agent cites. A glance appears under the reply, and a live page opens in a cmux pane. This note records the design decisions and the alternatives they beat, so the next change starts from the same evidence. The README says how to use it.

## Files stay grouped by the reply that cited them

One reply often cites several files: a before and after pair, four screen widths, or a clip with a report. They all form one group, in citation order, and a later reply never replaces an earlier one. The session entry `pstack-media` stores one group per reply, keyed by the reply's entry id, so a repeated settle adds nothing.

Four page layouts were built and compared in a throwaway prototype:

| Layout | Verdict |
| --- | --- |
| One tab per file, as `cmux open a.png b.png` gives you | Rejected. Ten files from four replies make ten tabs, and no tab says which reply it came from. |
| Latest reply only, with Older and Newer buttons | Rejected as the page. Its before and after compare view was kept. |
| Session feed: the newest reply in full, older replies as thumbnail strips | Chosen. Every file stays with its reply, and the page reads top to bottom. |
| One large viewer with a strip of thumbnails | Rejected as the page. Its full-size viewer, with arrow keys, was kept. |

Inside a group, two images captioned before and after get side-by-side, swipe, and flip views. Three or more images make a grid. Anything else stacks.

## Each group is headed by its time and the reply text

A turn number means nothing once several replies pile up. Each group shows the time the reply landed, adding the date for other days, then the file count. Below that comes the reply text, clamped to three lines. Show more appears only when the text overflows at the current pane width. The text leaves out the media citations, since the figures below already show those captions.

## The agent cites files, and Pi copies them

The extension reads only the final reply. It picks up Markdown images, Markdown links to media, and bare media paths outside fenced code. A prompt line asks the model to cite media as `![caption](/absolute/path)`, so citations are reliable. Images that a tool returns without a file path are not collected yet (https://github.com/aaalexliu/pstack-pi/issues/50).

Each cited file is copied into a content-addressed store under `<agent dir>/pstack-pi/media/`. Later edits to `/tmp/shot.png` cannot change an earlier reply's evidence, and a fork or resume needs no rules about which session owns a file. Nothing cleans up the store yet (https://github.com/aaalexliu/pstack-pi/issues/51).

## The terminal shows a glance, and the page shows everything

Under the reply, the glance has a header line, the page link, and up to four thumbnails, and `ctrl+o` shows the rest. Pi turns inline images off inside tmux, so a remote session in tmux shows only the header and the link. The page is the full view in every case.

## One loopback server per Pi process

Each TUI Pi process serves its own feed on `127.0.0.1`, behind a random token in the URL path. Each process serves only its own feed, so no writers share state. A design that published the feed as files on disk was rejected, because it added a manifest, atomic renames, and a decoder without removing a real risk.

The page polls `feed.json` with an ETag instead of holding a server-sent event stream open, because polling recovers by itself after a reconnect. Updates keep existing nodes, keyed by reply, so a playing video keeps playing and an embedded PDF does not reload. Files are served with byte ranges, because WebKit needs them to play video.

## Opening the pane: automatic locally, one click over ssh

In local cmux, Pi runs `cmux browser open-split` on the first media reply and reuses that split afterwards.

Over `cmux ssh`, Pi cannot open the split. The cmux relay rejects `browser.open_split` from a remote process with `remote_relay_denied`, and cmux's remote link policy requires a click on the Mac. So the glance prints the URL and the user clicks it once. cmux's browser then reaches the remote loopback address under the host name `cmux-loopback.localtest.me`, so the server accepts that name next to `127.0.0.1` and `localhost`. Without it, the page loads but its feed and files are rejected with 421.

cmux's own `agent-session` surface was rejected. It runs only Codex, Claude Code, and OpenCode, and its transcript strips images.

## Known gaps

- A Pi restart starts a new server, so the old split shows "Pi is not reachable" and a new split opens (https://github.com/aaalexliu/pstack-pi/issues/49).
- Collapsing a reply after widening the pane can leave a needless Show more, and removed groups keep their resize observers (https://github.com/aaalexliu/pstack-pi/issues/53).
- The pull requests that built this are https://github.com/aaalexliu/pstack-pi/pull/47, https://github.com/aaalexliu/pstack-pi/pull/48, and https://github.com/aaalexliu/pstack-pi/pull/52.
