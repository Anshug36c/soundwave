import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanMetadata, displayTitle, searchQuery, trackKeyOf, cleanQuery, excludeKey, VERSION_TYPE } from '../metadata.js';

// Ported case-for-case from Echo Music v1.4.3,
// metadata/src/test/kotlin/com/music/echo/metadata/cleaner/MetadataCleanerTest.kt
// so the JS pipeline and the Kotlin original cannot drift apart silently.

test('official-video and quality tags are stripped', () => {
  const r = cleanMetadata('Alan Walker - Faded (Official Music Video) [4K]', 'Alan Walker');
  assert.equal(r.cleanTitle, 'Faded');
  assert.equal(r.primaryArtist, 'Alan Walker');
  assert.equal(r.version, null);
  assert.ok(r.junkTags.some((t) => /official music video/i.test(t)));
});

test('remix survives in version info, not in the clean title', () => {
  const r = cleanMetadata('Illenium - Crawl Outta Love (The Glitch Mob Remix) [Official Audio]', 'Illenium');
  assert.equal(r.cleanTitle, 'Crawl Outta Love');
  assert.equal(r.primaryArtist, 'Illenium');
  assert.ok(r.version);
  assert.equal(r.version.type, VERSION_TYPE.REMIX);
  assert.equal(r.version.description, 'The Glitch Mob Remix');
  assert.equal(displayTitle(r), 'Crawl Outta Love (The Glitch Mob Remix)');
  assert.equal(searchQuery(r)[0], 'Crawl Outta Love');
});

test('featuring artists are extracted from the title', () => {
  const r = cleanMetadata('Major Lazer - Lean On (feat. MØ) (Official Lyric Video)', 'Major Lazer');
  assert.equal(r.cleanTitle, 'Lean On');
  assert.equal(r.primaryArtist, 'Major Lazer');
  assert.ok(r.featuredArtists.includes('MØ'), 'should contain MØ in featured artists');
});

test('Topic channels are cleaned', () => {
  const r = cleanMetadata('Yellow', 'Coldplay - Topic');
  assert.equal(r.cleanTitle, 'Yellow');
  assert.equal(r.primaryArtist, 'Coldplay');
});

test('VEVO channels are cleaned and camel-cased apart', () => {
  const r = cleanMetadata('Blank Space', 'TaylorSwiftVEVO');
  assert.equal(r.cleanTitle, 'Blank Space');
  assert.equal(r.primaryArtist, 'Taylor Swift');
});

test('CJK brackets are cleaned', () => {
  const r = cleanMetadata('RADWIMPS - 前前前世 【Official MV】', 'RADWIMPS');
  assert.equal(r.cleanTitle, '前前前世');
  assert.equal(r.primaryArtist, 'RADWIMPS');
});

test('trailing pipe and status are cleaned', () => {
  const r = cleanMetadata('Song Name | Official Visualizer 2024', 'Artist');
  assert.equal(r.cleanTitle, 'Song Name');
  assert.equal(r.primaryArtist, 'Artist');
});

test('live performance version is preserved', () => {
  const r = cleanMetadata('Hotel California (Live on MTV 1994) [HD]', 'Eagles');
  assert.equal(r.cleanTitle, 'Hotel California');
  assert.equal(r.version?.type, VERSION_TYPE.LIVE);
  assert.equal(r.version?.description, 'Live on MTV 1994');
});

test('acoustic version is preserved', () => {
  const r = cleanMetadata('Take On Me (Acoustic Version)', 'a-ha');
  assert.equal(r.cleanTitle, 'Take On Me');
  assert.equal(r.version?.type, VERSION_TYPE.ACOUSTIC);
});

test('multi-artist separators in the artist field', () => {
  const r = cleanMetadata('Title', 'Calvin Harris & Dua Lipa');
  assert.equal(r.primaryArtist, 'Calvin Harris');
  assert.equal(r.cleanArtist, 'Calvin Harris & Dua Lipa');
  assert.ok(r.featuredArtists.includes('Dua Lipa'));
  const [qTitle, qArtist] = searchQuery(r);
  assert.equal(qTitle, 'Title');
  assert.equal(qArtist, 'Calvin Harris & Dua Lipa');
});

test('a solo title with a dash inside parens does not corrupt the artist', () => {
  const r = cleanMetadata('Alone - (Official Video)', 'Marshmello');
  assert.equal(r.cleanTitle, 'Alone');
  assert.equal(r.primaryArtist, 'Marshmello');
});

test('artist-side junk is never split into the title', () => {
  const r = cleanMetadata('Alan Walker - Official Music Video', 'Alan Walker - Topic');
  assert.equal(r.primaryArtist, 'Alan Walker');
  assert.notEqual(r.cleanTitle, 'Official Music Video', 'title should not be set to junk');
});

test('HTML entities and smart quotes are decoded', () => {
  const r = cleanMetadata('Rock &amp; Roll &#39;King&#39; “Edition”', 'Artist');
  assert.equal(r.cleanTitle, 'Rock & Roll \'King\' "Edition"');
});

test('hashtags are stripped and recorded as junk', () => {
  const r = cleanMetadata('Best Song Ever #shorts #trending', 'Artist');
  assert.equal(r.cleanTitle, 'Best Song Ever');
  assert.ok(r.junkTags.includes('#shorts'));
});

test('multiple featuring artists across title and artist field', () => {
  const r = cleanMetadata('Major Lazer & DJ Snake - Lean On feat. MØ', '');
  assert.equal(r.cleanTitle, 'Lean On');
  assert.equal(r.primaryArtist, 'Major Lazer');
  assert.ok(r.featuredArtists.includes('DJ Snake'));
  assert.ok(r.featuredArtists.includes('MØ'));
});

test('slowed + reverb version is preserved', () => {
  const r = cleanMetadata('After Dark (Slowed + Reverb)', 'Mr. Kitty');
  assert.equal(r.cleanTitle, 'After Dark');
  assert.equal(r.version?.type, VERSION_TYPE.SLOWED);
  assert.equal(r.version?.description, 'Slowed + Reverb');
});

test('band names with conjunctions are preserved in the search query', () => {
  const simon = cleanMetadata('The Sound of Silence', 'Simon & Garfunkel');
  assert.equal(simon.cleanTitle, 'The Sound of Silence');
  assert.equal(searchQuery(simon)[1], 'Simon & Garfunkel');

  const earth = cleanMetadata('September', 'Earth, Wind & Fire');
  assert.equal(earth.cleanTitle, 'September');
  assert.equal(searchQuery(earth)[1], 'Earth, Wind & Fire');

  const florence = cleanMetadata('Dog Days Are Over', 'Florence and the Machine');
  assert.equal(florence.cleanTitle, 'Dog Days Are Over');
  assert.equal(searchQuery(florence)[1], 'Florence and the Machine');
});

// --- SoundWave-specific surface (no upstream equivalent) -----------------

test('trackKeyOf trims and lowercases without cleaning', () => {
  assert.equal(trackKeyOf('  Starboy ', ' The Weeknd '), 'starboy|the weeknd');
  assert.equal(trackKeyOf('Starboy', 'The Weeknd'), trackKeyOf('STARBOY', 'THE WEEKND'));
});

test('cleanQuery strips pasted video noise but never empties a query', () => {
  assert.equal(cleanQuery('Alan Walker - Faded (Official Music Video) [4K]'), 'Alan Walker Faded');
  // Provider ordering comes back in the order it was typed, pipes and all gone.
  assert.equal(
    cleanQuery('Laembadgini - Diljit Dosanjh (Full Video Song) | Latest Punjabi Songs 2016'),
    'Laembadgini Diljit Dosanjh Latest Punjabi Songs 2016',
  );
  assert.equal(cleanQuery('love'), 'love', 'nothing to clean: the query is untouched');
  assert.equal(cleanQuery('[4K]'), '[4K]', 'junk-only input must fall back to the original');
  assert.equal(cleanQuery('  '), '');
  assert.equal(cleanQuery(null), '');
});

test('cleaning is deterministic and side-effect free', () => {
  const a = cleanMetadata('Song (Official Video)', 'Artist - Topic');
  const b = cleanMetadata('Song (Official Video)', 'Artist - Topic');
  assert.deepEqual(a, b);
  assert.equal(a.rawTitle, 'Song (Official Video)', 'raw fields stay untouched');
  assert.equal(a.rawArtist, 'Artist - Topic');
});

test('video noise is stripped from provider-style titles', () => {
  // The call path SoundWave actually uses: title + a known artist. With an
  // artist present, stage 2 only re-splits when one side matches it, so a
  // "Title - Artist" ordering (common on DJPunjab) is never swapped.
  const r = cleanMetadata('Laembadgini (Full Video Song) [HD]', 'Diljit Dosanjh');
  assert.equal(r.cleanTitle, 'Laembadgini');
  assert.equal(r.primaryArtist, 'Diljit Dosanjh');
  assert.ok(r.junkTags.length >= 2, 'both the bracket and the quality tag are junk');
});

test('with no artist at all, upstream reads "Left - Right" as artist-title', () => {
  // Faithful to the Kotlin pipeline: stage 2 assumes YouTube's "Artist - Title"
  // ordering whenever the left side is not obviously junk. Documented here so a
  // future reader does not mistake it for a SoundWave bug — this is why every
  // lyrics/matching call site passes the artist it already has.
  const r = cleanMetadata('Laembadgini - Diljit Dosanjh (Full Video Song)', '');
  assert.equal(r.primaryArtist, 'Laembadgini');
  assert.equal(r.cleanTitle, 'Diljit Dosanjh');
});

test('excludeKey matches the client twin byte-for-byte', () => {
  // Wire contract: client/src/services/taste.js computes the same key, and the
  // same expectations are asserted there. Change one, change both.
  assert.equal(excludeKey('Nimbooda Nimbooda', 'A. R. Rahman'), 'nimboodanimbooda|arrahman');
  assert.equal(excludeKey('Ça Va', 'Kafkaya'), excludeKey('ca va', 'kafkaya'));
  assert.equal(excludeKey(' Faded ', 'Alan Walker'), 'faded|alanwalker');
  assert.notEqual(excludeKey('Faded', 'Alan Walker'), excludeKey('Faded', 'Someone Else'));
});
