const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  // Create Super Admin
  const hashedPassword = await bcrypt.hash(process.env.SUPER_ADMIN_PASSWORD || 'Saikumar273@', 12);
  
  const superAdmin = await prisma.user.upsert({
    where: { email: process.env.SUPER_ADMIN_EMAIL || 'rapetisaikumar7@gmail.com' },
    update: {},
    create: {
      fullName: process.env.SUPER_ADMIN_NAME || 'Super Admin',
      email: process.env.SUPER_ADMIN_EMAIL || 'rapetisaikumar7@gmail.com',
      password: hashedPassword,
      role: 'SUPER_ADMIN',
      isActive: true,
      isEmailVerified: true,
    },
  });

  console.log('Super Admin created:', superAdmin.email);

  // Create sample training materials
  const materials = [
    {
      title: 'Resume Writing Guide',
      description: 'Complete guide to writing an ATS-friendly resume',
      type: 'document',
      content: 'Learn how to craft a resume that passes Applicant Tracking Systems...',
      category: 'Interview Prep',
      isPublished: true,
    },
    {
      title: 'Common Interview Questions',
      description: 'Top 50 interview questions and how to answer them',
      type: 'document',
      content: 'Prepare for your next interview with these commonly asked questions...',
      category: 'Interview Prep',
      isPublished: true,
    },
    {
      title: 'LinkedIn Profile Optimization',
      description: 'How to optimize your LinkedIn profile for job hunting',
      type: 'document',
      content: 'Your LinkedIn profile is your digital resume. Learn how to optimize it...',
      category: 'Career Development',
      isPublished: true,
    },
  ];

  for (const material of materials) {
    await prisma.trainingMaterial.create({ data: material });
  }

  console.log('Sample training materials created');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
