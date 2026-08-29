import { verifyConnection, sendEmail } from '../services/emailService';

/**
 * src/scripts/testEmail.ts
 *
 * Isolated development script to verify the Ethereal SMTP connection
 * and send a single test email without touching PostgreSQL.
 */

async function main() {
  console.log('🧪 Starting Email Integration Test...');

  try {
    console.log('🔄 Verifying SMTP connection...');
    const isConnected = await verifyConnection();
    if (isConnected) {
      console.log('✅ SMTP connection successful.\n');
    }

    console.log('📤 Sending test email...');
    const result = await sendEmail({
      to: 'test-recipient@example.com',
      subject: 'Hello from Phase 6',
      text: 'This is the plain text version of the email.',
      html: '<p>This is the <strong>HTML</strong> version of the email.</p>',
    });

    console.log('✅ Email sent successfully!');
    console.log(`📝 Message ID: ${result.messageId}`);
    
    if (result.previewUrl) {
      console.log(`\n👀 Ethereal Preview URL:\n${result.previewUrl}\n`);
    } else {
      console.log('\n👀 No preview URL available.\n');
    }
  } catch (error) {
    console.error('❌ Failed to send test email:', error);
    process.exit(1);
  }

  process.exit(0);
}

main();
