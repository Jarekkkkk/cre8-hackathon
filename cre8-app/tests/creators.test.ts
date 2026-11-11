import { expect, test } from 'bun:test';
import { rankCreators, CRE8_CREATOR, creatorId } from '../src/lib/creators';
import { REFERENCE_FUNDS } from '../src/lib/public-funds';
import type { ReferenceFund } from '../src/lib/public-funds';
const other = '0x1111111111111111111111111111111111111111';
function fund(slug: string, creator: string | undefined, value: number | null): ReferenceFund {
  return { ...REFERENCE_FUNDS[0]!, slug, creator, returns: { ...REFERENCE_FUNDS[0]!.returns, '7D': value } };
}
test('catalogue models are grouped by creator, not public figures or fund names', () => {
  const creators = rankCreators(REFERENCE_FUNDS, '7D');
  expect(creators).toHaveLength(1);
  expect(creators[0]!.id).toBe(CRE8_CREATOR);
  expect(creators[0]!.funds).toHaveLength(30);
});
test('case-insensitive creator identity, deduplicated funds, explicit equal weighting and missing data', () => {
  const a = fund('a', CRE8_CREATOR.toUpperCase(), 20);
  const creators = rankCreators([a, a, fund('b', CRE8_CREATOR, -10), fund('c', CRE8_CREATOR, null), fund('d', other, 8), fund('missing', undefined, 100), fund('bad', 'Elon Musk', 100)], '7D');
  expect(creators.map(c => c.id)).toEqual([other, CRE8_CREATOR]);
  expect(creators[1]!.funds.map(f => f.slug)).toEqual(['a', 'b', 'c']);
  expect(creators[1]!.measuredFunds).toBe(2);
  expect(creators[1]!.averageReturn).toBe(5);
});
test('no valid history stays unavailable and ranks after measured creators', () => {
  const creators = rankCreators([fund('missing', other, null), fund('available', CRE8_CREATOR, -10)], '7D');
  expect(creators.map(c => c.id)).toEqual([CRE8_CREATOR, other]);
  expect(creators[1]!.averageReturn).toBeNull();
  expect(creatorId('cre8')).toBe(CRE8_CREATOR);
  expect(creatorId('not-an-address')).toBeNull();
});
