const { chromium } = require('playwright');
const PDFDocument = require('pdfkit');
const aiService = require('./aiService');
const { uploadStreamToCloudinary, uploadToCloudinary } = require('./cloudinaryService');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const os = require('os');

class AutoApplyService {
  /**
   * Auto-apply to a single job — main entry point
   * @param {Object} jobData - { applyUrl, employerName, matchScore }
   * @param {Object} userData - user profile from DB
   * @param {Function} [onProgress] - callback(event) for live streaming; event = { type, data }
   */
  async applyToJob(jobData, userData, onProgress) {
    const emit = onProgress || (() => {});
    const steps = [];
    const screenshots = [];
    let browser;

    try {
      // Step 1: Launch browser (headed — visible to user)
      this._addStep(steps, 'Launching browser');
      emit({ type: 'step', data: { index: 0, label: 'Launching browser', status: 'in-progress' } });
      emit({ type: 'log', data: { message: 'Opening browser window — you will see it on your screen' } });
      browser = await chromium.launch({
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--start-maximized'],
      });
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 900 },
      });
      const page = await context.newPage();
      this._markSuccess(steps);
      emit({ type: 'step', data: { index: 0, label: 'Launching browser', status: 'success' } });
      emit({ type: 'log', data: { message: 'Browser launched successfully' } });

      // Step 2: Navigate to job URL
      this._addStep(steps, 'Navigating to job page');
      emit({ type: 'step', data: { index: 1, label: 'Navigating to job page', status: 'in-progress' } });
      emit({ type: 'log', data: { message: `Navigating to: ${jobData.applyUrl}` } });
      await page.goto(jobData.applyUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);
      const ss1 = await page.screenshot({ type: 'jpeg', quality: 60 });
      screenshots.push({ label: 'Job Page', buffer: ss1 });
      emit({ type: 'screenshot', data: { label: 'Job Page', base64: ss1.toString('base64') } });

      // Check for blockers after navigation
      await this._checkForBlockers(page, emit);

      const pageTitle = await page.title().catch(() => '');
      this._markSuccess(steps);
      emit({ type: 'step', data: { index: 1, label: 'Navigating to job page', status: 'success' } });
      emit({ type: 'log', data: { message: `Page loaded: ${pageTitle || jobData.applyUrl}` } });

      // Step 3: Extract page content
      this._addStep(steps, 'Reading job description');
      emit({ type: 'step', data: { index: 2, label: 'Reading job description', status: 'in-progress' } });
      emit({ type: 'log', data: { message: 'Extracting page text content...' } });
      const pageText = await page.evaluate(() => document.body.innerText);
      const wordCount = pageText.split(/\s+/).length;
      this._markSuccess(steps);
      emit({ type: 'step', data: { index: 2, label: 'Reading job description', status: 'success' } });
      emit({ type: 'log', data: { message: `Extracted ${wordCount} words from page` } });

      // Step 4: AI analyzes job page
      this._addStep(steps, 'Analyzing job with AI');
      emit({ type: 'step', data: { index: 3, label: 'Analyzing job with AI', status: 'in-progress' } });
      emit({ type: 'log', data: { message: 'Sending job description to AI for analysis...' } });
      const jdAnalysis = await aiService.analyzeJobPage(pageText);
      const aiDetail = `${jdAnalysis.jobTitle || 'Position'} at ${jdAnalysis.company || 'Company'}`;
      this._markSuccess(steps, aiDetail);
      emit({ type: 'step', data: { index: 3, label: 'Analyzing job with AI', status: 'success', details: aiDetail } });
      emit({ type: 'log', data: { message: `AI identified: ${jdAnalysis.jobTitle || 'Position'} at ${jdAnalysis.company || 'Company'}` } });
      if (jdAnalysis.skills?.length) {
        emit({ type: 'log', data: { message: `Required skills: ${jdAnalysis.skills.slice(0, 8).join(', ')}` } });
      }

      // Step 5: Generate AI-tailored resume
      this._addStep(steps, 'Generating tailored resume');
      emit({ type: 'step', data: { index: 4, label: 'Generating tailored resume', status: 'in-progress' } });
      emit({ type: 'log', data: { message: `Tailoring resume for ${userData.fullName}...` } });
      const tailoredContent = await aiService.tailorResumeContent(userData, jdAnalysis);
      const resumeResult = await this._generateAndUploadResume(userData, jdAnalysis, tailoredContent);
      const resumeDetail = `Match score: ${resumeResult.matchScore}%`;
      this._markSuccess(steps, resumeDetail);
      emit({ type: 'step', data: { index: 4, label: 'Generating tailored resume', status: 'success', details: resumeDetail } });
      emit({ type: 'log', data: { message: `Resume generated — match score: ${resumeResult.matchScore}%` } });

      // Step 6: Find and click "Apply" button
      this._addStep(steps, 'Finding application form');
      emit({ type: 'step', data: { index: 5, label: 'Finding application form', status: 'in-progress' } });
      emit({ type: 'log', data: { message: 'Looking for Apply button on the page...' } });
      const applyClicked = await this._findAndClickApply(page);
      if (applyClicked) {
        emit({ type: 'log', data: { message: 'Clicked Apply button — waiting for form to load...' } });
        await page.waitForTimeout(3000);
        const ss2 = await page.screenshot({ type: 'jpeg', quality: 60 });
        screenshots.push({ label: 'After clicking Apply', buffer: ss2 });
        emit({ type: 'screenshot', data: { label: 'After clicking Apply', base64: ss2.toString('base64') } });

        // Check for blockers after clicking apply (login, CAPTCHA, etc.)
        await this._checkForBlockers(page, emit);
      } else {
        emit({ type: 'log', data: { message: 'No Apply button found — analyzing current page as form' } });
      }

      // Step 7: Analyze the form
      emit({ type: 'log', data: { message: 'Analyzing form fields with AI...' } });
      const currentHtml = await page.content();
      const formAnalysis = await aiService.analyzeFormFields(currentHtml, userData);
      const formDetail = formAnalysis.canAutoFill
        ? `Found ${formAnalysis.fields?.length || 0} fields`
        : 'No auto-fillable form detected';
      this._markSuccess(steps, formDetail);
      emit({ type: 'step', data: { index: 5, label: 'Finding application form', status: 'success', details: formDetail } });
      emit({ type: 'log', data: { message: formDetail } });

      // Step 8: Fill form fields + answer screening questions
      let formFilled = false;
      let fillResult = { filled: 0, total: 0 };
      if (formAnalysis.canAutoFill && formAnalysis.fields?.length > 0) {
        this._addStep(steps, 'Filling application form');
        emit({ type: 'step', data: { index: 6, label: 'Filling application form', status: 'in-progress' } });

        // Answer screening questions first
        if (formAnalysis.screeningQuestions?.length > 0) {
          emit({ type: 'log', data: { message: `Answering ${formAnalysis.screeningQuestions.length} screening question(s)...` } });
          for (const sq of formAnalysis.screeningQuestions) {
            const answer = await aiService.answerQuestion(sq.question, userData, jdAnalysis);
            emit({ type: 'log', data: { message: `Q: "${sq.question.substring(0, 60)}..." → Answered` } });
            formAnalysis.fields.push({
              selector: sq.selector,
              type: sq.type || 'textarea',
              label: sq.question,
              value: answer,
              action: 'fill',
            });
          }
        }

        fillResult = await this._fillFormFields(page, formAnalysis, userData, resumeResult, emit);
        formFilled = fillResult.filled > 0;
        const ss3 = await page.screenshot({ type: 'jpeg', quality: 60 });
        screenshots.push({ label: 'Form Filled', buffer: ss3 });
        emit({ type: 'screenshot', data: { label: 'Form Filled', base64: ss3.toString('base64') } });

        // Check for blockers after filling (CAPTCHA, verification, etc.)
        await this._checkForBlockers(page, emit);

        const fillDetail = `Filled ${fillResult.filled}/${fillResult.total} fields`;
        this._markStep(steps, fillResult.filled > 0 ? 'success' : 'partial', fillDetail);
        emit({ type: 'step', data: { index: 6, label: 'Filling application form', status: fillResult.filled > 0 ? 'success' : 'partial', details: fillDetail } });

        // Step 9: Submit form
        if (formFilled && formAnalysis.submitButton) {
          this._addStep(steps, 'Submitting application');
          emit({ type: 'step', data: { index: 7, label: 'Submitting application', status: 'in-progress' } });
          emit({ type: 'log', data: { message: 'Clicking submit button...' } });
          try {
            await page.click(formAnalysis.submitButton, { timeout: 5000 });
            await page.waitForTimeout(3000);

            // Check for blockers after submit (CAPTCHA, verification)
            await this._checkForBlockers(page, emit);

            const ss4 = await page.screenshot({ type: 'jpeg', quality: 60 });
            screenshots.push({ label: 'After Submission', buffer: ss4 });
            emit({ type: 'screenshot', data: { label: 'After Submission', base64: ss4.toString('base64') } });
            this._markSuccess(steps);
            emit({ type: 'step', data: { index: 7, label: 'Submitting application', status: 'success' } });
            emit({ type: 'log', data: { message: 'Form submitted successfully' } });
          } catch {
            this._markStep(steps, 'partial', 'Submit button not clickable');
            emit({ type: 'step', data: { index: 7, label: 'Submitting application', status: 'partial', details: 'Submit button not clickable' } });
            emit({ type: 'log', data: { message: 'Submit button was not clickable — you can submit manually in the browser' } });

            // Wait for user to manually submit — 60 seconds with live screenshots
            emit({ type: 'log', data: { message: '⏳ Waiting 60 seconds — submit manually in the browser window...' } });
            emit({ type: 'blocker', data: { message: 'Submit button not clickable — please submit manually in the browser window', timeout: 60 } });
            await this._waitWithScreenshots(page, emit, 60000);
            emit({ type: 'log', data: { message: 'Continuing after manual wait...' } });
          }
        }
      } else {
        // No auto-fillable form — let user apply manually with live screenshots for 60s
        emit({ type: 'log', data: { message: 'No auto-fillable form detected — you can fill it manually in the browser window' } });
        emit({ type: 'blocker', data: { message: 'No form detected for auto-fill. Apply manually in the browser window.', timeout: 60 } });
        await this._waitWithScreenshots(page, emit, 60000);
        emit({ type: 'log', data: { message: 'Continuing after manual wait...' } });
      }

      // Final screenshot for report
      const ssFinal = await page.screenshot({ type: 'jpeg', quality: 60 });
      screenshots.push({ label: 'Final State', buffer: ssFinal });
      emit({ type: 'screenshot', data: { label: 'Final State', base64: ssFinal.toString('base64') } });

      // Step 10: Generate PDF report
      this._addStep(steps, 'Generating application report');
      emit({ type: 'step', data: { index: 8, label: 'Generating application report', status: 'in-progress' } });
      emit({ type: 'log', data: { message: 'Generating PDF report with screenshots...' } });
      const reportUrl = await this._generatePdfReport(screenshots, steps, jobData, userData, jdAnalysis, resumeResult, tailoredContent);
      this._markSuccess(steps);
      emit({ type: 'step', data: { index: 8, label: 'Generating application report', status: 'success' } });
      emit({ type: 'log', data: { message: 'Report uploaded successfully' } });

      return {
        success: true,
        formFilled,
        reportUrl,
        resumeUrl: resumeResult.filePath,
        matchScore: resumeResult.matchScore,
        jdAnalysis,
        steps: steps.map(s => ({ step: s.step, status: s.status, details: s.details })),
      };
    } catch (error) {
      console.error('Auto-apply error:', error);
      emit({ type: 'log', data: { message: `Error: ${error.message}` } });

      // Try to generate report even on failure
      let reportUrl = null;
      try {
        reportUrl = await this._generatePdfReport(screenshots, steps, jobData, userData, null, null, null);
      } catch {}

      return {
        success: false,
        error: error.message,
        reportUrl,
        steps: steps.map(s => ({ step: s.step, status: s.status, details: s.details })),
      };
    } finally {
      if (browser) {
        emit({ type: 'log', data: { message: 'Closing browser...' } });
        await browser.close();
      }
    }
  }

  /** Find and click the primary "Apply" button on the page */
  async _findAndClickApply(page) {
    const selectors = [
      'a:has-text("Apply Now")', 'button:has-text("Apply Now")',
      'a:has-text("Apply")', 'button:has-text("Apply")',
      'a:has-text("Quick Apply")', 'button:has-text("Quick Apply")',
      'a:has-text("Easy Apply")', 'button:has-text("Easy Apply")',
      'a:has-text("Submit Application")', 'button:has-text("Submit Application")',
      '[data-testid*="apply"]', '.apply-button', '#apply-button',
    ];

    for (const selector of selectors) {
      try {
        const el = page.locator(selector).first();
        if (await el.isVisible({ timeout: 1500 })) {
          await el.click({ timeout: 3000 });
          return true;
        }
      } catch {}
    }
    return false;
  }

  /** Fill form fields based on AI analysis — with live screenshot per field */
  async _fillFormFields(page, formAnalysis, userData, resumeResult, emit = () => {}) {
    let filled = 0;
    const total = formAnalysis.fields?.length || 0;

    for (const field of (formAnalysis.fields || [])) {
      try {
        if (!field.selector || !field.value) continue;
        const el = page.locator(field.selector).first();
        if (!(await el.isVisible({ timeout: 1500 }).catch(() => false))) continue;

        const fieldLabel = field.label || field.selector;
        emit({ type: 'log', data: { message: `Filling: ${fieldLabel}` } });

        switch (field.action || field.type) {
          case 'fill': case 'text': case 'email': case 'tel': case 'textarea':
            await el.fill(String(field.value), { timeout: 3000 });
            filled++;
            emit({ type: 'log', data: { message: `  ✓ ${fieldLabel} → "${String(field.value).substring(0, 50)}${field.value.length > 50 ? '...' : ''}"` } });
            break;
          case 'select':
            try {
              await el.selectOption({ label: String(field.value) }, { timeout: 3000 });
              filled++;
              emit({ type: 'log', data: { message: `  ✓ ${fieldLabel} → Selected "${field.value}"` } });
            } catch {
              try { await el.selectOption({ value: String(field.value) }, { timeout: 3000 }); filled++; emit({ type: 'log', data: { message: `  ✓ ${fieldLabel} → Selected "${field.value}"` } }); } catch {
                emit({ type: 'log', data: { message: `  ✗ ${fieldLabel} → Could not select option` } });
              }
            }
            break;
          case 'check': case 'checkbox': case 'radio':
            await el.check({ timeout: 3000 });
            filled++;
            emit({ type: 'log', data: { message: `  ✓ ${fieldLabel} → Checked` } });
            break;
          case 'file': case 'upload':
            if (resumeResult?.filePath) {
              try {
                emit({ type: 'log', data: { message: `  ↑ Uploading resume file...` } });
                const resp = await fetch(resumeResult.filePath);
                const buf = Buffer.from(await resp.arrayBuffer());
                const tmp = path.join(os.tmpdir(), `resume_${Date.now()}.pdf`);
                fs.writeFileSync(tmp, buf);
                await el.setInputFiles(tmp, { timeout: 5000 });
                filled++;
                emit({ type: 'log', data: { message: `  ✓ Resume uploaded` } });
                try { fs.unlinkSync(tmp); } catch {}
              } catch {
                emit({ type: 'log', data: { message: `  ✗ Resume upload failed` } });
              }
            }
            break;
          default:
            if (field.value) {
              try { await el.fill(String(field.value), { timeout: 3000 }); filled++; emit({ type: 'log', data: { message: `  ✓ ${fieldLabel} → "${String(field.value).substring(0, 50)}"` } }); } catch {
                emit({ type: 'log', data: { message: `  ✗ ${fieldLabel} → Fill failed` } });
              }
            }
        }

        // Live screenshot after each field
        try {
          const fieldSs = await page.screenshot({ type: 'jpeg', quality: 50 });
          emit({ type: 'screenshot', data: { label: `Filled: ${fieldLabel}`, base64: fieldSs.toString('base64') } });
        } catch {}

      } catch (err) {
        console.log(`Field fill failed [${field.label}]: ${err.message}`);
        emit({ type: 'log', data: { message: `  ✗ ${field.label || field.selector} → ${err.message}` } });
      }
    }
    emit({ type: 'log', data: { message: `Form filling complete: ${filled}/${total} fields filled` } });
    return { filled, total };
  }

  /** Generate and upload an AI-tailored resume PDF */
  async _generateAndUploadResume(userData, jdAnalysis, tailoredContent) {
    const fileName = `auto_apply_resume_${uuidv4()}`;

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });

      // Header
      doc.fontSize(24).font('Helvetica-Bold').fillColor('#1e3a5f')
        .text(userData.fullName, { align: 'center' });
      doc.moveDown(0.3);

      // Contact
      doc.fontSize(10).font('Helvetica').fillColor('#4a5568');
      const contact = [userData.email, userData.phone, userData.linkedinProfile].filter(Boolean);
      doc.text(contact.join('  |  '), { align: 'center' });
      if (userData.location) doc.text(userData.location, { align: 'center' });
      doc.moveDown(0.8);
      this._line(doc);
      doc.moveDown(0.5);

      // Professional Summary
      doc.fontSize(13).font('Helvetica-Bold').fillColor('#1e3a5f').text('PROFESSIONAL SUMMARY');
      doc.moveDown(0.3);
      doc.fontSize(10).font('Helvetica').fillColor('#333333')
        .text(tailoredContent.summary, { lineGap: 2 });
      doc.moveDown(0.5);
      this._line(doc);
      doc.moveDown(0.5);

      // Key Skills
      doc.fontSize(13).font('Helvetica-Bold').fillColor('#1e3a5f').text('KEY SKILLS');
      doc.moveDown(0.3);
      const skills = tailoredContent.highlightedSkills || userData.keySkills || [];
      doc.fontSize(10).font('Helvetica').fillColor('#333333')
        .text(skills.join('  •  '), { lineGap: 2 });
      doc.moveDown(0.5);
      this._line(doc);
      doc.moveDown(0.5);

      // Experience
      const exp = tailoredContent.tailoredExperience || userData.experience;
      if (exp) {
        doc.fontSize(13).font('Helvetica-Bold').fillColor('#1e3a5f').text('PROFESSIONAL EXPERIENCE');
        doc.moveDown(0.3);
        doc.fontSize(10).font('Helvetica').fillColor('#333333').text(exp, { lineGap: 2 });
        doc.moveDown(0.5);
        this._line(doc);
        doc.moveDown(0.5);
      }

      // Education
      if (userData.education) {
        doc.fontSize(13).font('Helvetica-Bold').fillColor('#1e3a5f').text('EDUCATION');
        doc.moveDown(0.3);
        doc.fontSize(10).font('Helvetica').fillColor('#333333').text(userData.education, { lineGap: 2 });
        doc.moveDown(0.5);
      }

      // Footer
      doc.moveDown(1);
      doc.fontSize(8).font('Helvetica-Oblique').fillColor('#999999')
        .text(`Resume tailored for: ${jdAnalysis.jobTitle || 'Position'} at ${jdAnalysis.company || 'Company'}`, { align: 'center' });

      doc.end();

      // Match score
      const jdSkills = (jdAnalysis.skills || []).map(s => s.toLowerCase());
      const userSkills = (userData.keySkills || []).map(s => s.toLowerCase());
      const matching = userSkills.filter(s => jdSkills.some(js => js.includes(s) || s.includes(js)));
      const matchScore = jdSkills.length > 0 ? Math.round((matching.length / jdSkills.length) * 100) : 50;

      uploadStreamToCloudinary(doc, fileName)
        .then(({ url }) => {
          resolve({
            fileName: `${fileName}.pdf`,
            filePath: url,
            matchScore: Math.min(matchScore + 15, 100),
            keywords: matching,
          });
        })
        .catch(reject);
    });
  }

  /** Generate PDF report with screenshots and steps */
  async _generatePdfReport(screenshots, steps, jobData, userData, jdAnalysis, resumeResult, tailoredContent) {
    const reportName = `auto_apply_report_${uuidv4()}`;

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 40, size: 'A4' });

      // Title
      doc.fontSize(22).font('Helvetica-Bold').fillColor('#1e3a5f')
        .text('Auto-Apply Report', { align: 'center' });
      doc.moveDown(0.3);
      doc.fontSize(10).font('Helvetica').fillColor('#666666')
        .text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
      doc.moveDown(1);

      // Job Info
      this._line(doc);
      doc.moveDown(0.5);
      doc.fontSize(14).font('Helvetica-Bold').fillColor('#1e3a5f').text('Job Details');
      doc.moveDown(0.3);
      doc.fontSize(10).font('Helvetica').fillColor('#333333');
      doc.text(`Company: ${jobData.employerName || jdAnalysis?.company || 'N/A'}`);
      doc.text(`Position: ${jdAnalysis?.jobTitle || 'N/A'}`);
      doc.text(`URL: ${jobData.applyUrl || 'N/A'}`);
      if (resumeResult) doc.text(`Match Score: ${resumeResult.matchScore}%`);
      doc.moveDown(0.5);

      // Applicant
      this._line(doc);
      doc.moveDown(0.5);
      doc.fontSize(14).font('Helvetica-Bold').fillColor('#1e3a5f').text('Applicant');
      doc.moveDown(0.3);
      doc.fontSize(10).font('Helvetica').fillColor('#333333');
      doc.text(`Name: ${userData.fullName}`);
      doc.text(`Email: ${userData.email}`);
      if (userData.phone) doc.text(`Phone: ${userData.phone}`);
      if (userData.jobRole) doc.text(`Target Role: ${userData.jobRole}`);
      doc.moveDown(0.5);

      // Steps
      this._line(doc);
      doc.moveDown(0.5);
      doc.fontSize(14).font('Helvetica-Bold').fillColor('#1e3a5f').text('Application Steps');
      doc.moveDown(0.3);
      steps.forEach((s, i) => {
        const icon = s.status === 'success' ? '[OK]' : s.status === 'failed' ? '[FAIL]' : s.status === 'partial' ? '[PARTIAL]' : '[...]';
        doc.fontSize(10).font('Helvetica').fillColor('#333333');
        doc.text(`${icon} Step ${i + 1}: ${s.step}${s.details ? ' - ' + s.details : ''}`, { lineGap: 2 });
      });
      doc.moveDown(0.5);

      // AI Analysis
      if (jdAnalysis) {
        this._line(doc);
        doc.moveDown(0.5);
        doc.fontSize(14).font('Helvetica-Bold').fillColor('#1e3a5f').text('AI Job Analysis');
        doc.moveDown(0.3);
        doc.fontSize(10).font('Helvetica').fillColor('#333333');
        if (jdAnalysis.description) doc.text(`Summary: ${jdAnalysis.description}`, { lineGap: 2 });
        if (jdAnalysis.skills?.length) doc.text(`Required Skills: ${jdAnalysis.skills.join(', ')}`, { lineGap: 2 });
        if (jdAnalysis.requirements?.length) doc.text(`Requirements: ${jdAnalysis.requirements.slice(0, 5).join(', ')}`, { lineGap: 2 });
        doc.moveDown(0.5);
      }

      // Resume link
      if (resumeResult) {
        this._line(doc);
        doc.moveDown(0.5);
        doc.fontSize(14).font('Helvetica-Bold').fillColor('#1e3a5f').text('Tailored Resume');
        doc.moveDown(0.3);
        doc.fontSize(10).font('Helvetica').fillColor('#2563eb')
          .text(resumeResult.filePath, { link: resumeResult.filePath, underline: true });
        doc.moveDown(0.5);
      }

      // Screenshots
      for (const ss of screenshots) {
        try {
          doc.addPage();
          doc.fontSize(12).font('Helvetica-Bold').fillColor('#1e3a5f')
            .text(`Screenshot: ${ss.label}`, { align: 'center' });
          doc.moveDown(0.5);
          doc.image(ss.buffer, { fit: [515, 680], align: 'center', valign: 'center' });
        } catch (err) {
          console.log('Screenshot PDF error:', err.message);
        }
      }

      doc.end();

      uploadStreamToCloudinary(doc, reportName)
        .then(({ url }) => resolve(url))
        .catch(reject);
    });
  }

  /**
   * Detect common blockers (CAPTCHA, login, popups) and pause 60s for user intervention.
   * Streams live screenshots every 3 seconds during the wait.
   */
  async _checkForBlockers(page, emit) {
    try {
      const html = await page.content();
      const text = await page.evaluate(() => document.body.innerText).catch(() => '');
      const lower = (html + ' ' + text).toLowerCase();

      const blockerPatterns = [
        { pattern: /captcha|recaptcha|hcaptcha|i.m not a robot|verify you.re human/i, label: 'CAPTCHA detected' },
        { pattern: /sign\s*in|log\s*in|create\s*an?\s*account|already have an account/i, label: 'Login/Sign-in required' },
        { pattern: /verify your email|email verification|confirm your email/i, label: 'Email verification required' },
        { pattern: /access denied|forbidden|blocked|rate.?limit/i, label: 'Access blocked' },
        { pattern: /cookie.?consent|accept.?cookies|cookie.?policy/i, label: 'Cookie consent popup' },
      ];

      for (const { pattern, label } of blockerPatterns) {
        if (pattern.test(lower)) {
          emit({ type: 'blocker', data: { message: `${label} — please resolve it in the browser window`, timeout: 60 } });
          emit({ type: 'log', data: { message: `⚠ Blocker detected: ${label}` } });
          emit({ type: 'log', data: { message: '⏳ Waiting 60 seconds — clear the blocker in the browser window...' } });
          await this._waitWithScreenshots(page, emit, 60000);
          emit({ type: 'log', data: { message: 'Resuming automation...' } });
          return true;
        }
      }
    } catch {}
    return false;
  }

  /**
   * Wait for the given duration, streaming a live screenshot every 3 seconds.
   */
  async _waitWithScreenshots(page, emit, durationMs) {
    const interval = 3000;
    const iterations = Math.ceil(durationMs / interval);
    for (let i = 0; i < iterations; i++) {
      await page.waitForTimeout(interval);
      try {
        const ss = await page.screenshot({ type: 'jpeg', quality: 50 });
        emit({ type: 'screenshot', data: { label: `Live view`, base64: ss.toString('base64') } });
      } catch {}
    }
  }

  _line(doc) {
    doc.strokeColor('#cbd5e0').lineWidth(1).moveTo(40, doc.y).lineTo(555, doc.y).stroke();
  }

  _addStep(steps, label) {
    steps.push({ step: label, status: 'in-progress', timestamp: new Date() });
  }

  _markSuccess(steps, details) {
    if (steps.length > 0) {
      steps[steps.length - 1].status = 'success';
      if (details) steps[steps.length - 1].details = details;
    }
  }

  _markStep(steps, status, details) {
    if (steps.length > 0) {
      steps[steps.length - 1].status = status;
      if (details) steps[steps.length - 1].details = details;
    }
  }
}

module.exports = new AutoApplyService();
