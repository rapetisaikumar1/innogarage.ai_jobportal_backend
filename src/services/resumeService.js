const PDFDocument = require('pdfkit');
const { v4: uuidv4 } = require('uuid');
const { uploadStreamToCloudinary } = require('./cloudinaryService');

class ResumeService {
  /**
   * Generate a tailored ATS-friendly resume based on user profile and job description
   */
  async generateTailoredResume(user, job) {
    const fileName = `tailored_${uuidv4()}`;
    
    // Extract keywords from job description
    const keywords = this.extractKeywords(job.description);
    const matchingSkills = this.matchSkills(user.keySkills || [], keywords);
    const matchScore = matchingSkills.length / Math.max(keywords.length, 1) * 100;

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });

      // Header - Name
      doc.fontSize(24)
        .font('Helvetica-Bold')
        .fillColor('#1e3a5f')
        .text(user.fullName, { align: 'center' });
      
      doc.moveDown(0.3);

      // Contact Info
      doc.fontSize(10)
        .font('Helvetica')
        .fillColor('#4a5568');

      const contactItems = [];
      if (user.email) contactItems.push(user.email);
      if (user.phone) contactItems.push(user.phone);
      if (user.linkedinProfile) contactItems.push(user.linkedinProfile);
      
      doc.text(contactItems.join('  |  '), { align: 'center' });
      doc.moveDown(0.8);

      // Horizontal line
      this.drawLine(doc);
      doc.moveDown(0.5);

      // Professional Summary
      doc.fontSize(13)
        .font('Helvetica-Bold')
        .fillColor('#1e3a5f')
        .text('PROFESSIONAL SUMMARY');
      doc.moveDown(0.3);

      const summary = this.generateSummary(user, job, matchingSkills);
      doc.fontSize(10)
        .font('Helvetica')
        .fillColor('#333333')
        .text(summary, { lineGap: 2 });
      doc.moveDown(0.5);

      this.drawLine(doc);
      doc.moveDown(0.5);

      // Key Skills
      doc.fontSize(13)
        .font('Helvetica-Bold')
        .fillColor('#1e3a5f')
        .text('KEY SKILLS');
      doc.moveDown(0.3);

      const allSkills = [...new Set([...matchingSkills, ...(user.keySkills || [])])];
      const skillsText = allSkills.join('  •  ');
      doc.fontSize(10)
        .font('Helvetica')
        .fillColor('#333333')
        .text(skillsText, { lineGap: 2 });
      doc.moveDown(0.5);

      this.drawLine(doc);
      doc.moveDown(0.5);

      // Experience
      if (user.experience) {
        doc.fontSize(13)
          .font('Helvetica-Bold')
          .fillColor('#1e3a5f')
          .text('PROFESSIONAL EXPERIENCE');
        doc.moveDown(0.3);
        doc.fontSize(10)
          .font('Helvetica')
          .fillColor('#333333')
          .text(user.experience, { lineGap: 2 });
        doc.moveDown(0.5);
        this.drawLine(doc);
        doc.moveDown(0.5);
      }

      // Education
      if (user.education) {
        doc.fontSize(13)
          .font('Helvetica-Bold')
          .fillColor('#1e3a5f')
          .text('EDUCATION');
        doc.moveDown(0.3);
        doc.fontSize(10)
          .font('Helvetica')
          .fillColor('#333333')
          .text(user.education, { lineGap: 2 });
        doc.moveDown(0.5);
      }

      // Tailored for section
      doc.moveDown(1);
      doc.fontSize(8)
        .font('Helvetica-Oblique')
        .fillColor('#999999')
        .text(`Resume tailored for: ${job.title} at ${job.company}`, { align: 'center' });

      doc.end();

      // Upload PDF stream directly to Cloudinary
      uploadStreamToCloudinary(doc, fileName)
        .then(({ url }) => {
          resolve({
            fileName: `${fileName}.pdf`,
            filePath: url,
            matchScore: Math.round(matchScore),
            keywords: matchingSkills,
          });
        })
        .catch(reject);
    });
  }

  drawLine(doc) {
    doc.strokeColor('#cbd5e0')
      .lineWidth(1)
      .moveTo(50, doc.y)
      .lineTo(545, doc.y)
      .stroke();
  }

  extractKeywords(description) {
    if (!description) return [];
    
    const techKeywords = [
      'javascript', 'typescript', 'python', 'java', 'c++', 'c#', 'go', 'rust', 'ruby', 'php', 'swift', 'kotlin',
      'react', 'angular', 'vue', 'next.js', 'node.js', 'express', 'django', 'flask', 'spring', 'laravel',
      'html', 'css', 'sass', 'scss', 'tailwind', 'bootstrap', 'material-ui',
      'sql', 'postgresql', 'mysql', 'mongodb', 'redis', 'elasticsearch', 'dynamodb',
      'aws', 'azure', 'gcp', 'docker', 'kubernetes', 'terraform', 'jenkins', 'ci/cd',
      'git', 'github', 'gitlab', 'agile', 'scrum', 'jira',
      'rest', 'graphql', 'api', 'microservices', 'serverless',
      'machine learning', 'deep learning', 'ai', 'data science', 'nlp',
      'selenium', 'cypress', 'jest', 'mocha', 'testing', 'tdd',
      'linux', 'devops', 'cloud', 'security', 'networking',
      'react native', 'flutter', 'ios', 'android', 'mobile',
      'tableau', 'power bi', 'excel', 'data analysis', 'analytics',
      'communication', 'leadership', 'teamwork', 'problem solving',
    ];

    const descLower = description.toLowerCase();
    return techKeywords.filter(kw => descLower.includes(kw));
  }

  matchSkills(userSkills, jobKeywords) {
    const userSkillsLower = userSkills.map(s => s.toLowerCase());
    return jobKeywords.filter(kw => 
      userSkillsLower.some(skill => skill.includes(kw) || kw.includes(skill))
    );
  }

  generateSummary(user, job, matchingSkills) {
    const yearsExp = user.experience ? 'Experienced' : 'Motivated';
    const skillsList = matchingSkills.length > 0 
      ? matchingSkills.slice(0, 5).join(', ')
      : (user.keySkills || []).slice(0, 5).join(', ');

    return `${yearsExp} professional seeking the ${job.title} position at ${job.company}. ` +
      `Bringing strong expertise in ${skillsList || 'relevant technologies'}. ` +
      `${user.education ? `Education background in ${user.education}. ` : ''}` +
      `Passionate about delivering high-quality solutions and contributing to team success.`;
  }
}

module.exports = new ResumeService();
