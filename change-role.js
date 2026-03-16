const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

async function main() {
  const prisma = new PrismaClient();
  try {
    // Find user with MIG-26004
    const users = await prisma.user.findMany({
      select: { id: true, email: true, role: true, fullName: true, registrationNumber: true }
    });
    console.log('All users:');
    users.forEach(u => console.log(`  ${u.registrationNumber} | ${u.email} | ${u.role} | ${u.fullName}`));
    
    // Update user MIG-26004 to SUPER_ADMIN
    const target = users.find(u => u.registrationNumber === 'MIG-26004');
    if (target) {
      await prisma.user.update({
        where: { id: target.id },
        data: { role: 'SUPER_ADMIN' }
      });
      console.log(`\nUpdated ${target.email} (${target.registrationNumber}) to SUPER_ADMIN`);
    } else {
      console.log('\nMIG-26004 not found. Listing all users above.');
    }
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await prisma.$disconnect();
  }
}
main();
