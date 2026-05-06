const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const prisma = new PrismaClient();

async function main() {
  const superAdminEmail = process.env.SUPER_ADMIN_EMAIL || 'teammavericks56@gmail.com';
  const superAdminPassword = process.env.SUPER_ADMIN_PASSWORD || 'Mig@1206';

  // Delete all related data first (child tables), then non-super-admin users
  console.log('Clearing all student/admin data...');

  // Delete in order to avoid FK constraints
  await prisma.shoutLike.deleteMany({});
  await prisma.shoutComment.deleteMany({});
  await prisma.shoutPost.deleteMany({});
  await prisma.supportQuery.deleteMany({});
  await prisma.successStory.deleteMany({});
  await prisma.sheetJobApplication.deleteMany({});
  await prisma.notification.deleteMany({});
  await prisma.trainingNote.deleteMany({});
  await prisma.chatMessage.deleteMany({});
  await prisma.mentorBooking.deleteMany({});
  await prisma.mentoringSlot.deleteMany({});
  await prisma.tailoredResume.deleteMany({});
  await prisma.jobApplication.deleteMany({});
  await prisma.job.deleteMany({});
  await prisma.trainingMaterial.deleteMany({});

  // Delete all non-super-admin users
  const deleted = await prisma.user.deleteMany({
    where: { role: { not: 'SUPER_ADMIN' } },
  });
  console.log(`Deleted ${deleted.count} non-super-admin users`);

  // Ensure super admin exists with correct credentials
  const hashedPassword = await bcrypt.hash(superAdminPassword, 12);
  const sa = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN' } });

  if (sa) {
    await prisma.user.update({
      where: { id: sa.id },
      data: { email: superAdminEmail, password: hashedPassword, isActive: true, isEmailVerified: true, role: 'SUPER_ADMIN' },
    });
    console.log('Super admin verified:', superAdminEmail);
  } else {
    await prisma.user.create({
      data: {
        fullName: 'Super Admin',
        email: superAdminEmail,
        password: hashedPassword,
        role: 'SUPER_ADMIN',
        isActive: true,
        isEmailVerified: true,
      },
    });
    console.log(`Super admin created: ${superAdminEmail}`);
  }

  console.log('Done! Only super admin remains.');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
