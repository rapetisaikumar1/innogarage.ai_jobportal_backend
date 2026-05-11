const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

const prisma = new PrismaClient();

async function resetDatabase() {
  console.log('Deleting all data...\n');

  // Delete in order (child tables first to respect foreign keys)
  const deleted = {};
  
  try { deleted.chatMessages = await prisma.chatMessage.deleteMany(); } catch(e) {}
  try { deleted.chatRooms = await prisma.chatRoom.deleteMany(); } catch(e) {}
  try { deleted.notifications = await prisma.notification.deleteMany(); } catch(e) {}
  try { deleted.bookings = await prisma.booking.deleteMany(); } catch(e) {}
  try { deleted.mentorSlots = await prisma.mentorSlot.deleteMany(); } catch(e) {}
  try { deleted.trainingEnrollments = await prisma.trainingEnrollment.deleteMany(); } catch(e) {}
  try { deleted.trainingModules = await prisma.trainingModule.deleteMany(); } catch(e) {}
  try { deleted.trainingPrograms = await prisma.trainingProgram.deleteMany(); } catch(e) {}
  try { deleted.users = await prisma.user.deleteMany(); } catch(e) {}

  for (const [table, result] of Object.entries(deleted)) {
    if (result) console.log(`  ${table}: ${result.count} records deleted`);
  }

  console.log('\nAll data deleted. You can start fresh now.');
  await prisma.$disconnect();
}

resetDatabase().catch((e) => { console.error(e); process.exit(1); });
