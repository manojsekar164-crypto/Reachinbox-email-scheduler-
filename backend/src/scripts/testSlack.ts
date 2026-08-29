import dotenv from 'dotenv';
import path from 'path';
import { sendSlackNotification } from '../services/slackService';

// Ensure we load .env from the root
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

async function main() {
  console.log('🧪 Starting ReachInbox Phase 8 Slack Test...\n');

  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl || webhookUrl.trim() === '') {
    console.error('❌ FAIL: SLACK_WEBHOOK_URL is not set or is empty in .env');
    process.exit(1);
  }

  // Mask the secret webhook URL for security - showing first 15 and last 10 characters
  const maskedUrl = webhookUrl.length > 25
    ? `${webhookUrl.substring(0, 15)}...${webhookUrl.substring(webhookUrl.length - 10)}`
    : '***';

  console.log(`📡 Target Slack Webhook: ${maskedUrl}`);

  try {
    console.log('📤 Sending test message to Slack...');
    await sendSlackNotification(
      'ReachInbox Phase 8 Slack Test\n\nSlack integration is working.'
    );
    console.log('\n✅ PASS: Slack message sent successfully!');
  } catch (error: any) {
    console.error(`\n❌ FAIL: Slack notification failed: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
