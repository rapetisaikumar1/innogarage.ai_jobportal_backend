const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../config');
const prisma = require('../config/database');
const { sendVerificationEmail, sendPasswordResetEmail, sendLoginOtpEmail } = require('../services/emailService');
const { uploadToCloudinary } = require('../services/cloudinaryService');

// Generate unique registration number: MIG-26XXX
const generateRegistrationNumber = async () => {
  const lastUser = await prisma.user.findFirst({
    where: { registrationNumber: { not: null } },
    orderBy: { registrationNumber: 'desc' },
  });

  let nextNum = 1;
  if (lastUser && lastUser.registrationNumber) {
    const match = lastUser.registrationNumber.match(/MIG-26(\d+)/);
    if (match) nextNum = parseInt(match[1], 10) + 1;
  }

  return `MIG-26${String(nextNum).padStart(3, '0')}`;
};

const generateTokens = (userId, role) => {
  const accessToken = jwt.sign(
    { userId, role },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );
  const refreshToken = jwt.sign(
    { userId, role },
    config.jwt.refreshSecret,
    { expiresIn: config.jwt.refreshExpiresIn }
  );
  return { accessToken, refreshToken };
};

// Sign Up (Student only)
exports.signup = async (req, res) => {
  try {
    const { fullName, email, phone, password, education, experience, keySkills } = req.body;

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ message: 'Email already registered' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const verificationToken = crypto.randomBytes(32).toString('hex');

    let resumeUrl = null;
    if (req.file) {
      try {
        const result = await uploadToCloudinary(req.file.buffer, { folder: 'resumes', resourceType: 'raw' });
        resumeUrl = result.url;
      } catch (uploadErr) {
        console.warn('Resume upload skipped:', uploadErr.message);
      }
    }

    const registrationNumber = await generateRegistrationNumber();

    const user = await prisma.user.create({
      data: {
        fullName,
        email,
        phone,
        password: hashedPassword,
        registrationNumber,
        education,
        experience,
        keySkills: Array.isArray(keySkills) ? keySkills : keySkills ? keySkills.split(',').map(s => s.trim()) : [],
        resumeUrl,
        role: 'STUDENT',
        isActive: true, // Active after registration, email verification optional
        isEmailVerified: false,
        verificationToken,
        verificationTokenExpiry: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    // Send verification email
    await sendVerificationEmail(user, verificationToken);

    const { accessToken, refreshToken } = generateTokens(user.id, user.role);

    await prisma.user.update({
      where: { id: user.id },
      data: { refreshToken },
    });

    res.status(201).json({
      message: 'Registration successful. Please verify your email.',
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
        registrationNumber: user.registrationNumber,
      },
      accessToken,
      refreshToken,
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ message: 'Registration failed', error: error.message });
  }
};

// Login - Step 1: Validate credentials and send OTP
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    if (!user.isActive) {
      return res.status(403).json({ message: 'Account is deactivated. Contact support.' });
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiry = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    await prisma.user.update({
      where: { id: user.id },
      data: { loginOtp: otp, loginOtpExpiry: otpExpiry },
    });

    // Send OTP via email
    const emailResult = await sendLoginOtpEmail(user, otp);
    console.log(`\n🔑 OTP for ${user.email}: ${otp}\n`);

    res.json({
      message: 'Verification code sent to your email',
      requiresOtp: true,
      email: user.email,
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Login failed', error: error.message });
  }
};

// Login - Step 2: Verify OTP and return tokens
exports.verifyLoginOtp = async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ message: 'Email and OTP are required' });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    if (!user.loginOtp || !user.loginOtpExpiry) {
      return res.status(400).json({ message: 'No OTP requested. Please login again.' });
    }

    if (new Date() > user.loginOtpExpiry) {
      await prisma.user.update({
        where: { id: user.id },
        data: { loginOtp: null, loginOtpExpiry: null },
      });
      return res.status(400).json({ message: 'OTP has expired. Please login again.' });
    }

    if (user.loginOtp !== otp) {
      return res.status(401).json({ message: 'Invalid verification code' });
    }

    // Clear OTP after successful verification
    const { accessToken, refreshToken } = generateTokens(user.id, user.role);

    await prisma.user.update({
      where: { id: user.id },
      data: { refreshToken, loginOtp: null, loginOtpExpiry: null },
    });

    const profileComplete = !!user.education;

    res.json({
      message: 'Login successful',
      profileComplete,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
        registrationNumber: user.registrationNumber,
        isEmailVerified: user.isEmailVerified,
        education: user.education,
        profileCompleted: user.profileCompleted,
      },
      accessToken,
      refreshToken,
    });
  } catch (error) {
    console.error('OTP verification error:', error);
    res.status(500).json({ message: 'Verification failed', error: error.message });
  }
};

// Resend Login OTP
exports.resendLoginOtp = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.json({ message: 'If the account exists, a new code has been sent.' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiry = new Date(Date.now() + 5 * 60 * 1000);

    await prisma.user.update({
      where: { id: user.id },
      data: { loginOtp: otp, loginOtpExpiry: otpExpiry },
    });

    await sendLoginOtpEmail(user, otp);

    res.json({ message: 'A new verification code has been sent to your email.' });
  } catch (error) {
    console.error('Resend OTP error:', error);
    res.status(500).json({ message: 'Failed to resend code', error: error.message });
  }
};

// Verify Email
exports.verifyEmail = async (req, res) => {
  try {
    const { token } = req.params;

    const user = await prisma.user.findFirst({
      where: {
        verificationToken: token,
        verificationTokenExpiry: { gt: new Date() },
      },
    });

    if (!user) {
      return res.status(400).json({ message: 'Invalid or expired verification token' });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        isEmailVerified: true,
        verificationToken: null,
        verificationTokenExpiry: null,
      },
    });

    res.json({ message: 'Email verified successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Verification failed', error: error.message });
  }
};

// Forgot Password
exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.json({ message: 'If the email exists, a reset link has been sent' });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');

    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetPasswordToken: resetToken,
        resetPasswordExpiry: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
      },
    });

    await sendPasswordResetEmail(user, resetToken);

    res.json({ message: 'If the email exists, a reset link has been sent' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to process request', error: error.message });
  }
};

// Reset Password
exports.resetPassword = async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    const user = await prisma.user.findFirst({
      where: {
        resetPasswordToken: token,
        resetPasswordExpiry: { gt: new Date() },
      },
    });

    if (!user) {
      return res.status(400).json({ message: 'Invalid or expired reset token' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        resetPasswordToken: null,
        resetPasswordExpiry: null,
      },
    });

    res.json({ message: 'Password reset successful' });
  } catch (error) {
    res.status(500).json({ message: 'Password reset failed', error: error.message });
  }
};

// Refresh Token
exports.refreshToken = async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(401).json({ message: 'Refresh token required' });
    }

    const decoded = jwt.verify(refreshToken, config.jwt.refreshSecret);

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
    });

    if (!user || user.refreshToken !== refreshToken) {
      return res.status(401).json({ message: 'Invalid refresh token' });
    }

    const tokens = generateTokens(user.id, user.role);

    await prisma.user.update({
      where: { id: user.id },
      data: { refreshToken: tokens.refreshToken },
    });

    res.json(tokens);
  } catch (error) {
    res.status(401).json({ message: 'Invalid refresh token' });
  }
};

// Get Current User
exports.me = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        registrationNumber: true,
        fullName: true,
        email: true,
        phone: true,
        role: true,
        isActive: true,
        isEmailVerified: true,
        linkedinProfile: true,
        education: true,
        experience: true,
        keySkills: true,
        jobRole: true,
        resumeUrl: true,
        avatarUrl: true,
        assignedMentorId: true,
        subscriptionPlan: true,
        profileCompleted: true,
        createdAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json(user);
  } catch (error) {
    res.status(500).json({ message: 'Failed to get user', error: error.message });
  }
};

// Change Password
exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });

    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) {
      return res.status(400).json({ message: 'Current password is incorrect' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    await prisma.user.update({
      where: { id: user.id },
      data: { password: hashedPassword },
    });

    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Password change failed', error: error.message });
  }
};

// Google OAuth
exports.googleLogin = async (req, res) => {
  try {
    const { credential, profile } = req.body;

    let googleProfile = profile;
    if (credential) {
      try {
        const payload = JSON.parse(Buffer.from(credential.split('.')[1], 'base64').toString());
        googleProfile = {
          sub: payload.sub,
          email: payload.email,
          name: payload.name,
          picture: payload.picture,
          email_verified: payload.email_verified,
        };
      } catch (decodeErr) {
        return res.status(400).json({ message: 'Invalid Google token' });
      }
    }

    if (!googleProfile || !googleProfile.email) {
      return res.status(400).json({ message: 'Google profile email is required' });
    }

    let user = await prisma.user.findUnique({ where: { email: googleProfile.email } });
    let isNewUser = false;

    if (!user) {
      const hashedPassword = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 12);
      const registrationNumber = await generateRegistrationNumber();

      user = await prisma.user.create({
        data: {
          fullName: googleProfile.name || '',
          email: googleProfile.email,
          googleId: googleProfile.sub || googleProfile.id,
          avatarUrl: googleProfile.picture,
          password: hashedPassword,
          registrationNumber,
          role: 'STUDENT',
          isActive: true,
          isEmailVerified: true,
        },
      });
      isNewUser = true;
    }

    if (!user.isActive) {
      return res.status(403).json({ message: 'Account is deactivated' });
    }

    const profileComplete = !!user.education;
    const { accessToken, refreshToken } = generateTokens(user.id, user.role);

    await prisma.user.update({
      where: { id: user.id },
      data: { refreshToken, googleId: googleProfile.sub || googleProfile.id },
    });

    res.json({
      message: 'Login successful',
      isNewUser,
      profileComplete,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
        registrationNumber: user.registrationNumber,
        avatarUrl: user.avatarUrl,
        profileCompleted: user.profileCompleted,
      },
      accessToken,
      refreshToken,
    });
  } catch (error) {
    console.error('Google login error:', error);
    res.status(500).json({ message: 'Google login failed', error: error.message });
  }
};

// Complete Profile
exports.completeProfile = async (req, res) => {
  try {
    const { fullName, phone, education, experience, keySkills, linkedinProfile, jobRole, location } = req.body;
    const userId = req.user.id;

    let resumeUrl = null;
    if (req.file) {
      try {
        const result = await uploadToCloudinary(req.file.buffer, { folder: 'resumes', resourceType: 'raw' });
        resumeUrl = result.url;
      } catch (uploadErr) {
        console.warn('Resume upload skipped:', uploadErr.message);
      }
    }

    const updateData = {
      fullName: fullName || undefined,
      phone: phone || undefined,
      education: education || undefined,
      experience: experience || undefined,
      linkedinProfile: linkedinProfile || undefined,
      jobRole: jobRole || undefined,
      location: location || undefined,
      keySkills: Array.isArray(keySkills) ? keySkills : keySkills ? keySkills.split(',').map(s => s.trim()) : [],
      profileCompleted: true,
    };
    if (resumeUrl) updateData.resumeUrl = resumeUrl;

    let user = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: {
        id: true,
        registrationNumber: true,
        fullName: true,
        email: true,
        phone: true,
        role: true,
        isActive: true,
        isEmailVerified: true,
        linkedinProfile: true,
        education: true,
        experience: true,
        keySkills: true,
        jobRole: true,
        location: true,
        resumeUrl: true,
        avatarUrl: true,
        assignedMentorId: true,
        profileCompleted: true,
      },
    });

    // Auto-assign mentor to student after profile completion
    if (user.role === 'STUDENT' && !user.assignedMentorId) {
      // Fetch all active mentors with their assigned student count
      const mentors = await prisma.user.findMany({
        where: {
          role: 'ADMIN',
          isActive: true,
        },
        select: {
          id: true,
          createdAt: true,
          _count: {
            select: { assignedStudents: true },
          },
        },
      });

      if (mentors.length > 0) {
        // Sort by student count (ascending), then by createdAt (ascending)
        mentors.sort((a, b) => {
          const countDiff = a._count.assignedStudents - b._count.assignedStudents;
          if (countDiff !== 0) return countDiff;
          return new Date(a.createdAt) - new Date(b.createdAt);
        });

        // Select the mentor with the least load
        const selectedMentor = mentors[0];

        // Assign the mentor to the student
        user = await prisma.user.update({
          where: { id: userId },
          data: { assignedMentorId: selectedMentor.id },
          select: {
            id: true,
            registrationNumber: true,
            fullName: true,
            email: true,
            phone: true,
            role: true,
            isActive: true,
            isEmailVerified: true,
            education: true,
            experience: true,
            keySkills: true,
            resumeUrl: true,
            avatarUrl: true,
            assignedMentorId: true,
            profileCompleted: true,
          },
        });

        console.log(`Auto-assigned mentor ${selectedMentor.id} to student ${userId} (mentor load: ${selectedMentor._count.assignedStudents} students)`);
      }
    }

    // Auto-create group chat for the student with all admins & super admins
    if (user.role === 'STUDENT') {
      const existingGroup = await prisma.chatGroup.findUnique({ where: { studentId: userId } });
      if (!existingGroup) {
        const staff = await prisma.user.findMany({
          where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] }, isActive: true },
          select: { id: true },
        });
        await prisma.chatGroup.create({
          data: {
            name: `${user.fullName}'s Group`,
            studentId: userId,
            members: {
              create: [
                { userId },
                ...staff.map(s => ({ userId: s.id })),
              ],
            },
          },
        });
        console.log(`Auto-created group chat for student ${userId} with ${staff.length} staff members`);
      }
    }

    res.json({ message: 'Profile completed successfully', user });
  } catch (error) {
    console.error('Complete profile error:', error);
    res.status(500).json({ message: 'Failed to complete profile', error: error.message });
  }
};

// Logout
exports.logout = async (req, res) => {
  try {
    await prisma.user.update({
      where: { id: req.user.id },
      data: { refreshToken: null },
    });
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Logout failed' });
  }
};
