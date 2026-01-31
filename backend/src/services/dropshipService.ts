import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { randomUUID } from 'crypto';
import { env } from '../config/env.js';
import {
  getDynamoClient,
  getTableName,
  GetCommand,
  PutCommand,
  QueryCommand,
  priceKeys,
  orderKeys,
  orderGSI1Keys,
} from '../config/dynamodb.js';

export interface BuylistItem {
  quantity: number;
  cardName: string;
}

export interface CardInfo {
  cardName: string;
  cardNumber: string | null;
  set: string | null;
  priceUsd: number | null;
  priceCny: number | null;
}

export interface PricedItem extends BuylistItem {
  cardNumber: string | null;
  set: string | null;
  unitPriceUsd: number | null;
  unitPriceCny: number | null;  // Falls back to USD if not available
  totalPriceCny: number | null;
  found: boolean;
}

export interface GeocodedLocation {
  displayName: string;
  latitude: number;
  longitude: number;
}

export interface DropshipRequest {
  email: string;
  city: string;
  items: BuylistItem[];
  location?: GeocodedLocation;
}

export interface Order {
  orderId: string;
  email: string;
  city: string;
  location?: GeocodedLocation;
  items: PricedItem[];
  subtotalCny: number;
  createdAt: string;
  status: 'pending' | 'processing' | 'completed' | 'cancelled';
}

// SES client - only initialized if we have a recipient configured
let sesClient: SESClient | null = null;

function getSesClient(): SESClient {
  if (!sesClient) {
    sesClient = new SESClient({ region: env.AWS_REGION });
  }
  return sesClient;
}

/**
 * Look up card info including prices from DynamoDB.
 */
async function getCardInfo(cardName: string): Promise<CardInfo | null> {
  const client = getDynamoClient();
  const keys = priceKeys(cardName);

  try {
    const result = await client.send(
      new GetCommand({
        TableName: getTableName(),
        Key: keys,
      })
    );

    if (result.Item) {
      const priceUsd = typeof result.Item.priceUsd === 'number' ? result.Item.priceUsd : null;
      const priceCny = typeof result.Item.priceCny === 'number' ? result.Item.priceCny : null;

      // If no prices at all, card not found
      if (priceUsd === null && priceCny === null) {
        return null;
      }

      return {
        cardName: result.Item.cardName || cardName,
        cardNumber: result.Item.cardNumber || null,
        set: result.Item.set || null,
        priceUsd,
        priceCny,
      };
    }
    return null;
  } catch (error) {
    console.error(`Failed to get card info for: ${cardName}`, error);
    return null;
  }
}

/**
 * Validate and price a buylist submission.
 * Looks up prices from DynamoDB.
 */
export async function checkBuylist(items: BuylistItem[]): Promise<{
  valid: boolean;
  totalCards: number;
  lineItems: number;
  pricedItems: PricedItem[];
  subtotalCny: number;
  allFound: boolean;
}> {
  const totalCards = items.reduce((sum, item) => sum + item.quantity, 0);

  // Look up prices for all items
  const pricedItems: PricedItem[] = await Promise.all(
    items.map(async (item) => {
      const cardInfo = await getCardInfo(item.cardName);

      if (!cardInfo) {
        return {
          ...item,
          cardNumber: null,
          set: null,
          unitPriceUsd: null,
          unitPriceCny: null,
          totalPriceCny: null,
          found: false,
        };
      }

      // Use CNY price, fall back to USD as CNY if not available
      const unitPriceCny = cardInfo.priceCny ?? cardInfo.priceUsd;

      return {
        ...item,
        cardNumber: cardInfo.cardNumber,
        set: cardInfo.set,
        unitPriceUsd: cardInfo.priceUsd,
        unitPriceCny,
        totalPriceCny: unitPriceCny !== null ? unitPriceCny * item.quantity : null,
        found: true,
      };
    })
  );

  const subtotalCny = pricedItems.reduce(
    (sum, item) => sum + (item.totalPriceCny || 0),
    0
  );

  const allFound = pricedItems.every((item) => item.found);

  return {
    valid: items.length > 0 && totalCards > 0,
    totalCards,
    lineItems: items.length,
    pricedItems,
    subtotalCny,
    allFound,
  };
}

/**
 * Save an order to DynamoDB.
 */
async function saveOrder(order: Order): Promise<void> {
  const client = getDynamoClient();
  const keys = orderKeys(order.orderId);
  const gsi1Keys = orderGSI1Keys(order.createdAt, order.orderId);

  await client.send(
    new PutCommand({
      TableName: getTableName(),
      Item: {
        ...keys,
        ...gsi1Keys,
        ...order,
      },
    })
  );
}

/**
 * Get an order by ID.
 */
export async function getOrder(orderId: string): Promise<Order | null> {
  const client = getDynamoClient();
  const keys = orderKeys(orderId);

  const result = await client.send(
    new GetCommand({
      TableName: getTableName(),
      Key: keys,
    })
  );

  if (!result.Item) {
    return null;
  }

  return result.Item as Order;
}

/**
 * List recent orders (most recent first).
 */
export async function listOrders(limit = 50): Promise<Order[]> {
  const client = getDynamoClient();

  const result = await client.send(
    new QueryCommand({
      TableName: getTableName(),
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: {
        ':pk': 'ORDERS',
      },
      ScanIndexForward: false, // Most recent first
      Limit: limit,
    })
  );

  return (result.Items || []) as Order[];
}

/**
 * Submit a dropship request - stores in DynamoDB and sends email notification.
 */
export async function submitDropshipRequest(request: DropshipRequest): Promise<{
  success: boolean;
  message: string;
  orderId?: string;
}> {
  const { email, city, items, location } = request;

  // Get priced items
  const checkResult = await checkBuylist(items);

  // Create order
  const orderId = randomUUID();
  const shippingUsd = 20;
  const estimatedTotalCny = (checkResult.subtotalCny * 1.2) + shippingUsd;

  const order: Order = {
    orderId,
    email,
    city: location?.displayName || city || '',
    location,
    items: checkResult.pricedItems,
    subtotalCny: checkResult.subtotalCny,
    createdAt: new Date().toISOString(),
    status: 'pending',
  };

  // Save to DynamoDB
  try {
    await saveOrder(order);
  } catch (error) {
    console.error('Failed to save order:', error);
    throw new Error('Failed to save order');
  }

  // Format the buylist for the email
  const buylistText = checkResult.pricedItems
    .map((item) => {
      const setInfo = item.set && item.cardNumber ? ` [${item.set} #${item.cardNumber}]` : '';
      const priceStr = item.unitPriceCny !== null
        ? `¥${item.unitPriceCny.toFixed(2)} ea = ¥${item.totalPriceCny!.toFixed(2)}`
        : '(price not found)';
      return `${item.quantity}x ${item.cardName}${setInfo} - ${priceStr}`;
    })
    .join('\n');

  const emailBody = `
New Dropship Request

Order ID: ${orderId}
From: ${email}
City: ${city || 'Not provided'}

Buylist (${checkResult.totalCards} cards, ${checkResult.lineItems} line items):
----------------------------------------
${buylistText}
----------------------------------------
Subtotal: ¥${checkResult.subtotalCny.toFixed(2)} CNY
Shipping: $${shippingUsd.toFixed(2)} USD
Estimated Total (with 20% buffer): ¥${estimatedTotalCny.toFixed(2)} CNY
${!checkResult.allFound ? '\n⚠️ Some cards were not found in price database.\n' : ''}

Reply to this email to respond to the customer.
`.trim();

  const htmlBody = `
<h2>New Dropship Request</h2>
<p><strong>Order ID:</strong> ${orderId}</p>
<p><strong>From:</strong> ${email}</p>
<p><strong>City:</strong> ${city || 'Not provided'}</p>

<h3>Buylist (${checkResult.totalCards} cards, ${checkResult.lineItems} line items)</h3>
<table style="border-collapse: collapse; width: 100%; max-width: 600px;">
  <thead>
    <tr style="background-color: #f0f0f0;">
      <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">Qty</th>
      <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">Card</th>
      <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">Set</th>
      <th style="border: 1px solid #ddd; padding: 8px; text-align: right;">Unit (CNY)</th>
      <th style="border: 1px solid #ddd; padding: 8px; text-align: right;">Total (CNY)</th>
    </tr>
  </thead>
  <tbody>
    ${checkResult.pricedItems.map(item => `
    <tr${!item.found ? ' style="color: #cc0000;"' : ''}>
      <td style="border: 1px solid #ddd; padding: 8px;">${item.quantity}</td>
      <td style="border: 1px solid #ddd; padding: 8px;">${item.cardName}</td>
      <td style="border: 1px solid #ddd; padding: 8px;">${item.set && item.cardNumber ? `${item.set} #${item.cardNumber}` : '—'}</td>
      <td style="border: 1px solid #ddd; padding: 8px; text-align: right;">${item.unitPriceCny !== null ? `¥${item.unitPriceCny.toFixed(2)}` : '—'}</td>
      <td style="border: 1px solid #ddd; padding: 8px; text-align: right;">${item.totalPriceCny !== null ? `¥${item.totalPriceCny.toFixed(2)}` : '—'}</td>
    </tr>
    `).join('')}
  </tbody>
  <tfoot>
    <tr>
      <td colspan="4" style="border: 1px solid #ddd; padding: 8px;">Subtotal</td>
      <td style="border: 1px solid #ddd; padding: 8px; text-align: right;">¥${checkResult.subtotalCny.toFixed(2)}</td>
    </tr>
    <tr>
      <td colspan="4" style="border: 1px solid #ddd; padding: 8px;">Shipping</td>
      <td style="border: 1px solid #ddd; padding: 8px; text-align: right;">$${shippingUsd.toFixed(2)} USD</td>
    </tr>
    <tr style="font-weight: bold;">
      <td colspan="4" style="border: 1px solid #ddd; padding: 8px;">Estimated Total (with 20% buffer)</td>
      <td style="border: 1px solid #ddd; padding: 8px; text-align: right;">¥${estimatedTotalCny.toFixed(2)}</td>
    </tr>
  </tfoot>
</table>

${!checkResult.allFound ? '<p style="color: #cc0000;">⚠️ Some cards were not found in price database.</p>' : ''}

<p><em>Reply to this email to respond to the customer.</em></p>
`.trim();

  // Check if email sending is configured
  if (!env.DROPSHIP_RECIPIENT_EMAIL) {
    // Dev mode - just log
    console.log('=== DROPSHIP REQUEST (email not configured) ===');
    console.log(emailBody);
    console.log('===============================================');

    return {
      success: true,
      message: 'Request saved (email not configured)',
      orderId,
    };
  }

  try {
    const client = getSesClient();

    const command = new SendEmailCommand({
      Source: env.DROPSHIP_SENDER_EMAIL || env.DROPSHIP_RECIPIENT_EMAIL,
      Destination: {
        ToAddresses: [env.DROPSHIP_RECIPIENT_EMAIL],
      },
      ReplyToAddresses: [email],
      Message: {
        Subject: {
          Data: `Dropship Request: ${orderId.slice(0, 8)} - ¥${estimatedTotalCny.toFixed(2)} CNY`,
          Charset: 'UTF-8',
        },
        Body: {
          Text: {
            Data: emailBody,
            Charset: 'UTF-8',
          },
          Html: {
            Data: htmlBody,
            Charset: 'UTF-8',
          },
        },
      },
    });

    await client.send(command);

    return {
      success: true,
      message: 'Request submitted successfully',
      orderId,
    };
  } catch (error) {
    console.error('Failed to send dropship email:', error);
    // Order is saved even if email fails
    return {
      success: true,
      message: 'Request saved (email notification failed)',
      orderId,
    };
  }
}

// ============================================
// Admin/Script functions for managing prices
// ============================================

/**
 * Set the price for a card. Used by import scripts.
 */
export async function setCardPrice(cardName: string, price: number): Promise<void> {
  const client = getDynamoClient();
  const keys = priceKeys(cardName);

  await client.send(
    new PutCommand({
      TableName: getTableName(),
      Item: {
        ...keys,
        cardName: cardName.trim(),
        cardNameNormalized: cardName.toLowerCase().trim(),
        price,
        updatedAt: new Date().toISOString(),
      },
    })
  );
}

/**
 * Set prices for multiple cards. Used by import scripts.
 */
export async function setCardPrices(
  prices: Array<{ cardName: string; price: number }>
): Promise<{ success: number; failed: number }> {
  let success = 0;
  let failed = 0;

  for (const { cardName, price } of prices) {
    try {
      await setCardPrice(cardName, price);
      success++;
    } catch (error) {
      console.error(`Failed to set price for ${cardName}:`, error);
      failed++;
    }
  }

  return { success, failed };
}
