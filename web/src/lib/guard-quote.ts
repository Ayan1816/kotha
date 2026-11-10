/**
 * The Spending Guard renders one armed intent. Dry-run must select the card
 * the user clicked. Falling back to an older quote shows the wrong preview.
 */
export type GuardCard = {
  id: string;
  intent: {
    action: string;
    amount: string;
    recipient: string;
  };
};

export function selectArmedQuote<T extends GuardCard>(cards: readonly T[], intentId: string): T | null {
  const id = intentId.trim();
  if (!id) return null;
  return cards.find((card) => card.id === id) ?? null;
}
