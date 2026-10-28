# Collection Companion for Moxfield

A Firefox add-on for deck building on Moxfield. It does three things.

1. It marks each card in an open deck with the number of copies that are free. A free copy is a copy that no other deck of yours uses.
2. It finds cards in your collection that can replace a card. It sorts them into reprints, likely upgrades, likely downgrades, close variants and cards with a similar role.
3. It lets you browse your collection by Scryfall Tagger tags. You do not need to know the tag names first.

All data stays in your browser profile. The add-on reads public Moxfield data and Scryfall bulk files. It never writes to Moxfield.

## Install

Firefox release builds accept only signed add-ons. Pick one of these three methods.

### Method A: temporary install (any Firefox)

Firefox removes a temporary add-on when it restarts. Use this method to try the add-on.

1. Open `about:debugging#/runtime/this-firefox`.
2. Click "Load Temporary Add-on".
3. Select `manifest.json` in the `moxfield-companion` folder.

### Method B: permanent install without signing

This method works only in Firefox Developer Edition, Nightly or ESR.

1. Open `about:config`.
2. Set `xpinstall.signatures.required` to `false`.
3. Open `about:addons`.
4. Click the gear icon, then click "Install Add-on From File".
5. Select `moxfield-companion-0.2.0.xpi`.

### Method C: sign it for your own use (release Firefox)

Mozilla signs "unlisted" add-ons for free. An unlisted add-on does not appear in the public catalog.

1. Create API credentials at <https://addons.mozilla.org/developers/addon/api/key/>.
2. In the `moxfield-companion` folder, run the command below.
3. Install the signed `.xpi` from the `web-ext-artifacts` folder with step 4 of method B.

```
npx web-ext sign --channel=unlisted --api-key=YOUR_KEY --api-secret=YOUR_SECRET
```

## First setup

The manager page opens after you install the add-on. To open it later, click "Manage data" in the sidebar.

1. Under "Scryfall card data and tags", click "Download now". The download is about 31 MB and takes less than a minute.
2. Under "Your collection", import your collection. On Moxfield, open your collection and export it as CSV. Then select that file. If your collection is public, you can click "Sync collection" instead. The add-on finds the collection from your user name.
3. Under "Your decks", type your Moxfield user name. Then click "Sync all decks".
4. Under "Formats that count", clear the formats that do not use up physical copies.
5. In the deck table, clear "Counts" for each deck that does not hold real cards.

If you already have the Scryfall bulk files, use "Import files you downloaded yourself" instead of step 1.

## Daily use

To open the sidebar, click the toolbar button or press Alt+Shift+M.

### Badges on a deck page

Open any deck on moxfield.com. The add-on works in all view modes: Text, Condensed Text, Visual Grid, Visual Stacks and Visual Spoiler.

Each card gets a colored badge that shows "free copies / owned copies". When you have playtest copies of a card, the owned part shows them with a "P". For example, "2/1+1P" means two free copies, from one real copy and one playtest copy.

| Color | Meaning |
|---|---|
| Green | You have enough free real copies for this deck. |
| Blue, striped | You have enough free copies only if you use playtest copies. In the image views, the outline is dashed. |
| Yellow | Some copies are free, but fewer than this deck needs. |
| Orange | You own the card, but other decks use every copy. |
| Red | You do not own the card. |
| Purple | The deck marks this entry as a proxy on Moxfield, so the add-on does not count it. |

Hover over a badge to see which decks use the card. When you view your own deck, the add-on does not count that deck against itself.

### Playtest copies

The add-on reads playtest cards from your collection. These are the rows with "Proxy" set in the CSV export, or the copies marked as proxy in the collection API. It keeps them apart from real copies.

A Moxfield deck cannot record whether it holds a real copy or a playtest copy. For this reason, the add-on assumes that other decks hold real copies first. A badge is green only when a real copy is free for certain. If a free copy exists only because you count playtest copies, the badge is blue.

Example: you own one real copy and one playtest copy of a card, and another deck uses one copy. The badge shows "1/1+1P" in blue. One copy is free, but it can be the playtest copy.

To ignore playtest copies, clear "Count playtest copies from my collection as owned" on the manager page.

### Card tab

To show a card in the sidebar, do one of these actions:

- Click the card's badge.
- Alt+click the card.
- Right-click the card and choose "Collection Companion: show this card".
- Type its name in the search box.

The tab shows how many copies are free and which decks hold the others. It also shows the card's Tagger tags, with the most specific tag first. Click a tag to list your cards with that tag. This replaces the Scryfall and Tagger round trip.

The similar-card search has these controls:

- "Look in" sets the pool. "My cards" is your collection, playtest copies included. "Free copies" is cards that have a copy no other deck uses. "All cards" is every card. Each result shows a green pill when a real copy is free and a blue pill when only playtest copies are free.
- "Colors" limits the results to the deck's color identity, the card's color identity, or no limit.
- "Legal in" removes cards that the deck's format does not allow.
- "Same type" keeps only cards that share a card type, for example creature.
- "MV ±" limits the difference in mana value.
- The "Wording / Role" slider sets what "similar" means. On the left, cards with the same mechanics and wording rank first. On the right, cards with the same Tagger roles rank first.

The results come in five groups:

| Group | Rule |
|---|---|
| Same card, different name | The rules text, cost and stats are equal. Example: Kodama's Reach for Cultivate. |
| Likely strictly better | The text is the same, and the cost, stats or numbers are equal or better. Example: Elvish Mystic for a more expensive mana elf. |
| Likely strictly worse | The text is the same, and the cost, stats or numbers are worse. Example: Shock for Lightning Bolt. |
| Close variants | The effect is the same, but the color, creature type, speed or a trade-off differs. Example: Dragon Fodder for Raise the Alarm. |
| Similar role | The rest, ranked by shared wording and shared Tagger tags. |

"Better" and "worse" come from a heuristic. Read the card before you swap it in.

### Deck tab

The Deck tab lists the cards in the open deck that are missing, in other decks, short of copies, or covered only by playtest copies. It also lists cards on the maybeboard that you cannot use now. Click "Alternatives" to open the card in the Card tab.

### Explore tab

The Explore tab groups a pool of cards by Tagger tags.

- "Function" shows the top-level functional groups, for example removal, ramp and card advantage. Click a group to see its sub-tags.
- "All tags" shows every tag, largest first.
- The search box finds tags by name, alias or description.
- "Cards" lists the cards under a tag, grouped by sub-tag. Select "Flat list" to see one list.
- The × next to a tag hides it everywhere. To show it again, open "Hidden tags" on the manager page.

## Keep data current

| Data | How to refresh |
|---|---|
| Scryfall cards and tags | Automatic every 7 days. Change the interval on the manager page, or click "Download now". |
| Decks | Click "Sync all decks". The add-on fetches only decks that changed on Moxfield. Click "Sync" on one row to sync one deck. |
| Collection | Import a new CSV export, or click "Sync collection" for a public collection. |

The deck that is open in a tab always comes live from Moxfield.

## Limits

- The add-on reads public decks only. To add an unlisted deck, paste its link under "Add one deck by link or id".
- Moxfield has no official API. The add-on uses the same endpoints as the Moxfield website. If Moxfield changes them, deck sync can stop working.
- Collection sync through the API needs a public collection. The CSV import works for a private collection.
- If Moxfield changes its page markup, the badges can stop appearing. The sidebar continues to work.
- Basic lands are not tracked.
- The background page keeps the card index in memory. This uses about 250 MB after the first similar-card search.
- If you remove the add-on, Firefox deletes its local data.

## Files

| Path | Purpose |
|---|---|
| `manifest.json` | Add-on manifest (Manifest V2, Firefox 115 or later). |
| `background.js` | Holds the data, runs sync jobs and answers messages. |
| `lib/engine.js` | Availability, similarity and tag exploration. |
| `lib/scryfall.js` | Streams the Scryfall bulk files into IndexedDB. |
| `lib/moxfield.js` | Calls the Moxfield API, one request at a time. |
| `content/` | Badges on moxfield.com deck pages. |
| `sidebar/` | The sidebar. |
| `manager/` | The manager page. |

Card data and Tagger tags come from Scryfall. Scryfall asks apps that show Tagger labels to let users hide a tag. The × in the Explore tab does this.
