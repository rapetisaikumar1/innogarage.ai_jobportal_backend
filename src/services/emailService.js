const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const config = require('../config');

let transporter = null;

const createTransporter = async () => {
  // Priority 1: Google OAuth2 (recommended)
  if (config.google.clientId && config.google.clientSecret && config.email.googleRefreshToken && config.email.user) {
    try {
      transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          type: 'OAuth2',
          user: config.email.user,
          clientId: config.google.clientId,
          clientSecret: config.google.clientSecret,
          refreshToken: config.email.googleRefreshToken,
        },
      });

      // Verify the transporter works
      await transporter.verify();
      console.log('✅ Email transporter configured with Google OAuth2');
      return;
    } catch (err) {
      console.warn('⚠️  Google OAuth2 email setup failed:', err.message);
      transporter = null;
    }
  }

  // Priority 2: App Password / SMTP
  if (config.email.user && config.email.pass && config.email.user !== 'your-email@gmail.com' && config.email.pass !== 'your-app-password') {
    transporter = nodemailer.createTransport({
      host: config.email.host,
      port: config.email.port,
      secure: false,
      auth: {
        user: config.email.user,
        pass: config.email.pass,
      },
    });
    console.log('✅ Email transporter configured with SMTP credentials');
    return;
  }

  console.warn('⚠️  Email credentials not configured. Emails will be logged to console instead.');
  console.warn('   Option 1: Set GOOGLE_REFRESH_TOKEN + GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + EMAIL_USER for OAuth2');
  console.warn('   Option 2: Set EMAIL_USER + EMAIL_PASS for App Password');
};

// Initialize transporter on startup
createTransporter();

const sendEmail = async ({ to, subject, html }) => {
  if (!transporter) {
    console.log('\n📧 EMAIL (console fallback):');
    console.log(`   To: ${to}`);
    console.log(`   Subject: ${subject}`);
    // Extract links from HTML for easy access
    const linkMatch = html.match(/href="(http[^"]+)"/);
    if (linkMatch) {
      console.log(`   🔗 Link: ${linkMatch[1]}`);
    }
    console.log('');
    return { messageId: 'console-fallback' };
  }
  try {
    const info = await transporter.sendMail({
      from: config.email.from,
      to,
      subject,
      html,
    });
    console.log('Email sent:', info.messageId);
    return info;
  } catch (error) {
    console.error('Email error:', error.message);
    // Log the link as fallback so the flow isn't completely broken
    const linkMatch = html.match(/href="(http[^"]+)"/);
    if (linkMatch) {
      console.log(`\n📧 EMAIL FAILED - Fallback link for ${to}:`);
      console.log(`   🔗 ${linkMatch[1]}\n`);
    }
    return null;
  }
};

const sendVerificationEmail = async (user, token) => {
  const verifyUrl = `${config.frontendUrl}/verify-email?token=${token}`;
  return sendEmail({
    to: user.email,
    subject: 'Verify Your Email - Maple Record',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h1 style="color: #2563eb;">Welcome to Maple Record!</h1>
        <p>Hi ${user.fullName},</p>
        <p>Thank you for signing up! Please verify your email address by clicking the button below:</p>
        <a href="${verifyUrl}" style="display: inline-block; padding: 12px 24px; background-color: #2563eb; color: white; text-decoration: none; border-radius: 8px; margin: 20px 0;">Verify Email</a>
        <p>Or copy and paste this link: <a href="${verifyUrl}">${verifyUrl}</a></p>
        <p>This link will expire in 24 hours.</p>
        <hr style="border: 1px solid #e5e7eb; margin: 20px 0;" />
        <p style="color: #6b7280; font-size: 12px;">If you didn't create an account, please ignore this email.</p>
      </div>
    `,
  });
};

const sendPasswordResetEmail = async (user, token) => {
  const resetUrl = `${config.frontendUrl}/reset-password?token=${token}`;
  return sendEmail({
    to: user.email,
    subject: 'Reset Your Password - Maple Record',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h1 style="color: #2563eb;">Password Reset</h1>
        <p>Hi ${user.fullName},</p>
        <p>You requested to reset your password. Click the button below to set a new password:</p>
        <a href="${resetUrl}" style="display: inline-block; padding: 12px 24px; background-color: #2563eb; color: white; text-decoration: none; border-radius: 8px; margin: 20px 0;">Reset Password</a>
        <p>Or copy and paste this link: <a href="${resetUrl}">${resetUrl}</a></p>
        <p>This link will expire in 1 hour.</p>
        <hr style="border: 1px solid #e5e7eb; margin: 20px 0;" />
        <p style="color: #6b7280; font-size: 12px;">If you didn't request a password reset, please ignore this email.</p>
      </div>
    `,
  });
};

const sendMentoringConfirmationEmail = async (student, mentor, slot, meetLink) => {
  return sendEmail({
    to: student.email,
    subject: 'Mentoring Session Confirmed - Maple Record',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h1 style="color: #2563eb;">Mentoring Session Confirmed!</h1>
        <p>Hi ${student.fullName},</p>
        <p>Your mentoring session has been confirmed with the following details:</p>
        <div style="background: #f3f4f6; padding: 16px; border-radius: 8px; margin: 20px 0;">
          <p><strong>Mentor:</strong> ${mentor.fullName}</p>
          <p><strong>Date:</strong> ${new Date(slot.startTime).toLocaleDateString()}</p>
          <p><strong>Time:</strong> ${new Date(slot.startTime).toLocaleTimeString()} - ${new Date(slot.endTime).toLocaleTimeString()}</p>
          ${meetLink ? `<p><strong>Google Meet:</strong> <a href="${meetLink}">${meetLink}</a></p>` : ''}
        </div>
        <p>Please be on time for your session.</p>
      </div>
    `,
  });
};

const sendLoginOtpEmail = async (user, otp) => {
  return sendEmail({
    to: user.email,
    subject: 'Your Login Verification Code - Maple Record',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h1 style="color: #2563eb;">Login Verification</h1>
        <p>Hi ${user.fullName},</p>
        <p>Your one-time verification code is:</p>
        <div style="background: #f3f4f6; padding: 20px; border-radius: 12px; text-align: center; margin: 20px 0;">
          <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #1e40af;">${otp}</span>
        </div>
        <p>This code will expire in <strong>5 minutes</strong>.</p>
        <p>If you didn't attempt to log in, please ignore this email or change your password immediately.</p>
        <hr style="border: 1px solid #e5e7eb; margin: 20px 0;" />
        <p style="color: #6b7280; font-size: 12px;">This is an automated email from Maple Record. Do not reply.</p>
      </div>
    `,
  });
};

module.exports = {
  sendEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendMentoringConfirmationEmail,
  sendLoginOtpEmail,
};
