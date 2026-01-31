import { useState } from 'react';
import {
  checkDropshipBuylist,
  submitDropshipRequest,
  geocodeCity,
  type BuylistItem,
  type PricedItem,
} from '../services/api';

function parseBuylist(text: string): BuylistItem[] {
  const lines = text.trim().split('\n').filter(line => line.trim());
  const items: BuylistItem[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip section headers (lines ending with ":")
    if (trimmed.endsWith(':')) {
      continue;
    }

    // Skip common section header variations
    if (/^(Legend|Champion|MainDeck|Battlefields?|Runes?|Sideboard|Deck|Main|Side)$/i.test(trimmed)) {
      continue;
    }

    // Match patterns like "4 Card Name" or "4x Card Name"
    const match = trimmed.match(/^(\d+)x?\s+(.+)$/i);
    if (match) {
      items.push({
        quantity: parseInt(match[1], 10),
        cardName: match[2].trim(),
      });
    } else if (trimmed) {
      // No quantity specified, assume 1
      items.push({
        quantity: 1,
        cardName: trimmed,
      });
    }
  }

  return items;
}

function DropshipPage() {
  const [email, setEmail] = useState('');
  const [city, setCity] = useState('');
  const [buylist, setBuylist] = useState('');
  const [checkResult, setCheckResult] = useState<{
    totalCards: number;
    lineItems: number;
    pricedItems: PricedItem[];
    subtotal: number;
    allFound: boolean;
  } | null>(null);
  const [geocodedCity, setGeocodedCity] = useState<{
    displayName: string;
    latitude: number;
    longitude: number;
  } | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitSuccess, setSubmitSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCheck = async () => {
    setError(null);
    setCheckResult(null);
    setGeocodedCity(null);

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email.trim()) {
      setError('Please enter your email address.');
      return;
    }
    if (!emailRegex.test(email.trim())) {
      setError('Please enter a valid email address.');
      return;
    }

    // Validate city is provided
    if (!city.trim()) {
      setError('Please enter your city for shipping estimate.');
      return;
    }

    const items = parseBuylist(buylist);
    if (items.length === 0) {
      setError('Please enter at least one card in your buylist.');
      return;
    }

    // Validate quantity limit (max 3 of each card)
    const overLimitCards = items.filter(item => item.quantity > 3);
    if (overLimitCards.length > 0) {
      const cardNames = overLimitCards.map(item => `"${item.cardName}" (${item.quantity}x)`).join(', ');
      setError(`Orders are limited to 3x of each card. Please reduce: ${cardNames}`);
      return;
    }

    setIsChecking(true);

    try {
      // Geocode the city
      const geoResponse = await geocodeCity(city);
      if (!geoResponse.data) {
        setError('Could not find that city. Please check the spelling or try a nearby city.');
        return;
      }
      setGeocodedCity(geoResponse.data);

      // Check the buylist
      const response = await checkDropshipBuylist(items, geoResponse.data.displayName);

      if (!response.data.valid) {
        setError('Invalid buylist. Please check your entries.');
        return;
      }

      // Check for unrecognized cards
      const unrecognizedCards = response.data.pricedItems.filter(item => !item.found);
      if (unrecognizedCards.length > 0) {
        const cardNames = unrecognizedCards.map(item => `"${item.cardName}"`).join(', ');
        setError(`Unrecognized card${unrecognizedCards.length > 1 ? 's' : ''}: ${cardNames}`);
        return;
      }

      setCheckResult({
        totalCards: response.data.totalCards,
        lineItems: response.data.lineItems,
        pricedItems: response.data.pricedItems,
        subtotal: response.data.subtotal,
        allFound: response.data.allFound,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to validate. Please try again.');
    } finally {
      setIsChecking(false);
    }
  };

  const handleSubmit = async () => {
    setError(null);

    if (!email) {
      setError('Please enter your email address.');
      return;
    }

    if (!checkResult) {
      setError('Please check your list first.');
      return;
    }

    const items = parseBuylist(buylist);

    setIsSubmitting(true);

    try {
      const response = await submitDropshipRequest(
        email,
        geocodedCity?.displayName || city,
        items,
        geocodedCity || undefined
      );

      if (!response.data.success) {
        setError(response.data.message || 'Failed to submit request.');
        return;
      }

      setSubmitSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit request. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (submitSuccess) {
    return (
      <div className="container dropship-page">
        <div className="dropship-success">
          <h1>Request Submitted!</h1>
          <p>
            Thanks for your order request. We'll review it and get back to you
            at <strong>{email}</strong> shortly.
          </p>
          <button
            className="btn-primary"
            onClick={() => {
              setSubmitSuccess(false);
              setEmail('');
              setCity('');
              setBuylist('');
              setCheckResult(null);
            }}
          >
            Submit Another Request
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="container dropship-page">
      <h1>Dropship Request</h1>
      <p className="dropship-intro">
        Enter your buylist and I'll reply back as quickly as I can with a cost
        and timing estimate. I'm committed to doing this <em>at cost</em>, and
        want to get product into the hands of real players.
        <br />
        Most orders will take 3 - 4 weeks to arrive.
      </p>

      <div className="dropship-form">
        <div className="form-group">
          <label htmlFor="email">Email Address</label>
          <input
            type="email"
            id="email"
            value={email}
            onChange={e => {
              setEmail(e.target.value);
              setCheckResult(null);
              setGeocodedCity(null);
            }}
            placeholder="you@example.com"
          />
        </div>

        <div className="form-group">
          <label htmlFor="city">City (for shipping estimate)</label>
          <input
            type="text"
            id="city"
            value={city}
            onChange={e => {
              setCity(e.target.value);
              setCheckResult(null);
              setGeocodedCity(null);
            }}
            placeholder="e.g., Los Angeles, CA"
          />
        </div>

        <div className="form-group">
          <label htmlFor="buylist">Buylist</label>
          <textarea
            id="buylist"
            value={buylist}
            onChange={e => {
              setBuylist(e.target.value);
              setCheckResult(null); // Reset check when list changes
            }}
            placeholder={`Enter cards, one per line:\n4 Card Name\n2x Another Card\nSingle Card`}
            rows={10}
          />
          <span className="form-hint">
            Paste your decklist directly - section headers are automatically ignored.
          </span>
        </div>

        <div className="form-actions">
          <button
            className="btn-secondary"
            onClick={handleCheck}
            disabled={isChecking || !buylist.trim()}
          >
            {isChecking ? 'Checking...' : 'Check'}
          </button>

          {checkResult && (
            <button
              className="btn-primary"
              onClick={handleSubmit}
              disabled={isSubmitting || !email}
            >
              {isSubmitting ? 'Submitting...' : 'Submit Request'}
            </button>
          )}
        </div>

        {checkResult && (
          <div className="check-result">
            <div className="check-summary">
              {checkResult.totalCards} card{checkResult.totalCards !== 1 ? 's' : ''} across{' '}
              {checkResult.lineItems} line item{checkResult.lineItems !== 1 ? 's' : ''} ready to submit.
            </div>
            {geocodedCity && (
              <div className="geocoded-city">Shipping to: {geocodedCity.displayName}</div>
            )}
            <div className="estimated-cost">
              Estimated Cost: ¥{((checkResult.subtotal * 1.2) + 20).toFixed(2)} CNY
            </div>
          </div>
        )}
      </div>

      {error && <div className="dropship-error">{error}</div>}
    </div>
  );
}

export default DropshipPage;
