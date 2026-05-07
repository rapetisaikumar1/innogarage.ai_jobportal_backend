const { GoogleGenerativeAI } = require('@google/generative-ai');

class AIService {
  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.warn('⚠️  GEMINI_API_KEY not set — AI auto-apply features will use basic mode');
      this.enabled = false;
      return;
    }
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.modelNames = [
      process.env.GEMINI_MODEL,
      'gemini-flash-latest',
      'gemini-2.5-flash',
      'gemini-2.0-flash-001',
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite-001',
    ].filter(Boolean);
    this.enabled = true;
    this._quotaExhausted = false;
  }

  /** Call Gemini with quota-aware fallback */
  async _generate(prompt) {
    if (this._quotaExhausted) return null;

    for (const modelName of this.modelNames) {
      try {
        const model = this.genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent(prompt);
        return result.response.text();
      } catch (err) {
        const message = err.message || '';
        if (message.includes('429')) {
          this._quotaExhausted = true;
          console.warn('AI quota exhausted — switching to basic mode for remaining calls');
          return null;
        }

        // Model unavailable or overloaded — try next model
        if (
          message.includes('404') ||
          message.includes('not found') ||
          message.includes('no longer available') ||
          message.includes('503') ||
          message.includes('Service Unavailable') ||
          message.includes('overloaded') ||
          message.includes('high demand')
        ) {
          console.warn(`Gemini model ${modelName} unavailable/overloaded — trying next model`);
          continue;
        }

        console.error('AI generate error:', message);
        return null;
      }
    }

    console.error('AI generate error: no configured Gemini model is available');
    return null;
  }

  /** Analyze a job page's text to extract JD, requirements, skills */
  async analyzeJobPage(pageText) {
    if (!this.enabled || this._quotaExhausted) return this._fallbackAnalysis(pageText);

    const prompt = `Analyze this job posting and extract information in JSON format:
{
  "jobTitle": "the job title",
  "company": "the company name",
  "location": "job location or Remote",
  "description": "2-3 sentence summary of the role",
  "requirements": ["list of key requirements"],
  "skills": ["list of required technical and soft skills"],
  "responsibilities": ["list of key responsibilities"],
  "hasApplicationForm": true/false,
  "applicationFormType": "simple/multi-step/external-redirect/login-required/none"
}

Page content:
${pageText.substring(0, 8000)}`;

    const text = await this._generate(prompt);
    if (text) {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) try { return JSON.parse(jsonMatch[0]); } catch {}
    }
    return this._fallbackAnalysis(pageText);
  }

  /** Generate tailored resume content for a specific job */
  async tailorResumeContent(userData, jdAnalysis) {
    if (!this.enabled || this._quotaExhausted) {
      return {
        summary: `Experienced ${userData.jobRole || 'professional'} with expertise in ${(userData.keySkills || []).slice(0, 5).join(', ')}.`,
        highlightedSkills: userData.keySkills || [],
        tailoredExperience: userData.experience || '',
      };
    }

    const prompt = `You are a professional resume writer. Generate tailored resume content matching the candidate to the job.

Candidate:
- Name: ${userData.fullName}
- Role: ${userData.jobRole || 'Not specified'}
- Skills: ${(userData.keySkills || []).join(', ')}
- Experience: ${userData.experience || 'Not specified'}
- Education: ${userData.education || 'Not specified'}

Job:
- Title: ${jdAnalysis.jobTitle || 'Not specified'}
- Company: ${jdAnalysis.company || 'Not specified'}
- Required Skills: ${(jdAnalysis.skills || []).join(', ')}
- Requirements: ${(jdAnalysis.requirements || []).join(', ')}

Return JSON only:
{
  "summary": "compelling 3-4 sentence professional summary tailored to this role",
  "highlightedSkills": ["skills ordered by relevance to this job"],
  "tailoredExperience": "rewritten experience emphasizing relevant achievements for this role"
}`;

    const text = await this._generate(prompt);
    if (text) {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) try { return JSON.parse(jsonMatch[0]); } catch {}
    }

    return {
      summary: `Experienced ${userData.jobRole || 'professional'} seeking ${jdAnalysis.jobTitle || 'this position'}.`,
      highlightedSkills: userData.keySkills || [],
      tailoredExperience: userData.experience || '',
    };
  }

  /**
   * Resume Pipeline — Phase 0: Analyze the candidate's uploaded resume format.
   * Extracts section headings (in order) and the bullet character used, so the
   * AI can replicate the EXACT structure and style rather than inventing its own.
   */
  _analyzeResumeFormat(resumeText) {
    if (!resumeText) return { sections: [], bulletChar: '-' };

    const SECTION_RE = /^(?:[A-Z][A-Z\s&/,\-–]{2,60}:?\s*)$/;
    const KNOWN_SECTIONS = /^(?:PROFESSIONAL\s+SUMMARY|PROFESSIONAL\s+EXPERIENCE|WORK\s+EXPERIENCE|EXPERIENCE|SKILLS|TECHNICAL\s+SKILLS|KEY\s+SKILLS|CORE\s+COMPETENCIES|EDUCATION|CERTIFICATIONS?|LICENSES?|PROJECTS?|ACHIEVEMENTS?|AWARDS?|PUBLICATIONS?|REFERENCES?|SUMMARY|OBJECTIVE|PROFILE|CONTACT|LANGUAGES?|VOLUNTEERING?|INTERESTS?|HOBBIES|ADDITIONAL|HIGHLIGHTS?|ACCOMPLISHMENTS?)/i;

    const sections = [];
    const seenSections = new Set();
    let bulletChar = '-';
    let bulletVotes = { '-': 0, '•': 0, '*': 0 };

    for (const line of resumeText.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (SECTION_RE.test(trimmed) || KNOWN_SECTIONS.test(trimmed)) {
        const heading = trimmed.replace(/:+\s*$/, '').trim().toUpperCase();
        if (!seenSections.has(heading)) { sections.push(heading); seenSections.add(heading); }
      }

      // Count bullet character votes
      if (/^\s*•/.test(line)) bulletVotes['•']++;
      else if (/^\s*-\s/.test(line)) bulletVotes['-']++;
      else if (/^\s*\*\s/.test(line)) bulletVotes['*']++;
    }

    // Determine dominant bullet character
    const winner = Object.entries(bulletVotes).sort((a, b) => b[1] - a[1])[0];
    if (winner && winner[1] > 0) bulletChar = winner[0];

    return { sections: sections.length > 0 ? sections : null, bulletChar };
  }

  /** Generate ATS-friendly plain-text resume content for an external/saved job */
  async generateATSResumeText(userData, jobData) {
    const candidateResume = this._normalizeResumeSourceText(userData.parsedResumeText || '');
    const jobTitle = jobData.job_title || jobData.title || userData.jobRole || 'Target Role';
    const company = jobData.employer_name || jobData.company || 'Target Company';
    const jobDescription = (jobData.jd || jobData.description || '').trim().substring(0, 3000);
    const safeLinkedIn = this._safeProfessionalUrl(userData.linkedinProfile);

    // Parse strong matches and missing skills for context
    const strongMatches = Array.isArray(jobData.strong_matches)
      ? jobData.strong_matches
      : (() => { try { return JSON.parse(jobData.strong_matches || '[]'); } catch { return []; } })();
    const missingSkills = Array.isArray(jobData.missing_skills)
      ? jobData.missing_skills
      : (() => { try { return JSON.parse(jobData.missing_skills || '[]'); } catch { return []; } })();

    if (!candidateResume && !(userData.experience || userData.education || (userData.keySkills || []).length > 0)) {
      return { text: this._fallbackATSResumeText(userData, jobData), provider: 'fallback' };
    }

    if (!this.enabled || this._quotaExhausted) {
      return { text: this._fallbackATSResumeText(userData, jobData), provider: 'fallback' };
    }

    // ── Phase 0: Analyze resume format so AI can replicate it exactly ──
    const fmt = this._analyzeResumeFormat(candidateResume);
    const sectionList = fmt.sections
      ? `The resume has these sections in this exact order:\n${fmt.sections.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}\n\nUse EXACTLY these section headings in EXACTLY this order — do not add, remove, rename, or reorder any section.`
      : 'Preserve all section headings from the original resume, in the same order they appear.';

    const bulletNote = `The resume uses "${fmt.bulletChar}" as the bullet character. Use "${fmt.bulletChar} " (with one space) for ALL bullet points in the output. Do NOT switch to a different character.`;

    const prompt = `You are a senior professional resume writer.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RESUME PIPELINE — YOUR TASK
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. READ the candidate's uploaded resume carefully. Understand every section, every job, every bullet.
2. REPLICATE the exact format and structure of that resume in your output.
3. TAILOR ONLY the following — nothing else:
   a. Professional Summary  → rewrite to target this specific job (4 sentences max)
   b. Skills section        → reorder so JD-matched skills appear first; append ≤3 plausible additions
   c. Experience bullets    → keep all originals; add 1–2 new JD-targeted bullets per role

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TARGET JOB
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Role: ${jobTitle}
Company: ${company}
Skills from candidate already matching this JD: ${strongMatches.slice(0, 8).join(', ') || '(see JD)'}
Skills in JD the candidate should highlight more: ${missingSkills.slice(0, 6).join(', ') || 'none'}

Job Description:
${jobDescription}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CANDIDATE'S UPLOADED RESUME (source of truth)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Name: ${userData.fullName || 'Candidate'}
LinkedIn: ${safeLinkedIn || 'N/A'}

${candidateResume || `Key Skills: ${(userData.keySkills || []).join(', ')}\nExperience: ${userData.experience || 'Not provided'}\nEducation: ${userData.education || 'Not provided'}`}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FORMAT RULES — NON-NEGOTIABLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STRUCTURE:
${sectionList}

BULLETS:
${bulletNote}

HEADINGS:
- Use ALL-CAPS for section headings (match the original resume's style exactly).
- Do NOT use markdown (**bold**, ##heading, code fences). Plain text only.

CONTENT PRESERVATION:
- Copy every original job title, company name, date range, degree, and certification exactly — character for character.
- Copy ALL original bullets verbatim first, THEN add 1–2 new JD-targeted bullets after them.
- Do NOT shorten, paraphrase, or delete any original bullet or sentence.

NO FABRICATION:
- Do NOT invent employers, projects, certifications, degrees, metrics, or dates not in the original resume.
- Do NOT use placeholders like "[Company]", "[Year]", or "[Add skill here]".
- Skill additions to the skills section must be plausible given the candidate's actual background (e.g., if they know AWS, Azure is plausible; if they only do Java, do NOT add Python).

SUMMARY REWRITE (4 sentences):
  Sentence 1: Candidate's role title + years of experience + #1 matched skill for THIS job.
  Sentence 2: 2–3 strongest matched skills (from the "Skills already matching" list).
  Sentence 3: Name the target company (${company}) and role (${jobTitle}) explicitly.
  Sentence 4: One quantified impact statement from the candidate's actual experience.

OUTPUT LENGTH:
- Output must be at least as long as the original resume.
- Begin directly with the first section heading — do NOT include the candidate's name or contact info at the top.

Begin the tailored resume now:`;

    const text = await this._generate(prompt);
    return text
      ? { text: this._cleanGeneratedResumeText(text), provider: 'gemini' }
      : { text: this._fallbackATSResumeText(userData, jobData), provider: 'fallback' };
  }

  /** Analyze HTML form and return field-filling instructions */
  async analyzeFormFields(pageHtml, userData) {
    if (!this.enabled || this._quotaExhausted) return { fields: [], canAutoFill: false };

    // Clean HTML — remove scripts, styles, comments
    const cleanHtml = pageHtml
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .substring(0, 15000);

    const prompt = `Analyze this HTML and find ALL form fields for a job application. Map each to the user's data.

User data:
- Full Name: ${userData.fullName}
- Email: ${userData.email}
- Phone: ${userData.phone || 'N/A'}
- Location: ${userData.location || 'N/A'}
- LinkedIn: ${userData.linkedinProfile || 'N/A'}
- Job Role: ${userData.jobRole || 'N/A'}
- Education: ${userData.education || 'N/A'}
- Experience: ${userData.experience || 'N/A'}
- Skills: ${(userData.keySkills || []).slice(0, 15).join(', ')}

HTML:
${cleanHtml}

Return JSON only:
{
  "canAutoFill": true/false,
  "fields": [
    {
      "selector": "CSS selector for the input",
      "type": "text|email|tel|select|textarea|file|checkbox|radio",
      "label": "what this field is for",
      "value": "value to fill from user data",
      "action": "fill|select|check|upload"
    }
  ],
  "submitButton": "CSS selector for submit button or null",
  "applyButton": "CSS selector for apply/submit button or null",
  "screeningQuestions": [
    {
      "selector": "CSS selector for the question textarea/input",
      "question": "the question text",
      "type": "text|textarea|select|radio"
    }
  ],
  "notes": "any important notes"
}`;

    const text = await this._generate(prompt);
    if (text) {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) try { return JSON.parse(jsonMatch[0]); } catch {}
    }
    return { fields: [], canAutoFill: false };
  }

  /** Answer a screening question intelligently */
  async answerQuestion(question, userData, jdAnalysis) {
    if (!this.enabled || this._quotaExhausted) return 'Yes';

    const prompt = `Answer this job application screening question professionally and concisely.

Candidate:
- Name: ${userData.fullName}
- Role: ${userData.jobRole || 'Professional'}
- Skills: ${(userData.keySkills || []).slice(0, 10).join(', ')}
- Experience: ${userData.experience || 'Experienced professional'}
- Location: ${userData.location || 'Flexible'}

Job: ${jdAnalysis.jobTitle || ''} at ${jdAnalysis.company || ''}

Question: "${question}"

Rules:
- Brief (1-3 sentences max)
- Professional and positive
- Yes/no questions: answer "Yes" if reasonable
- Years of experience: give reasonable number based on profile
- Salary: "Negotiable based on role and responsibilities"
- Work authorization: "Yes, authorized to work"
- Never fabricate information

Answer (just the answer text):`;

    const text = await this._generate(prompt);
    return text ? text.trim() : 'Yes';
  }

  _fallbackAnalysis(pageText) {
    const text = (pageText || '').substring(0, 3000).toLowerCase();
    return {
      jobTitle: 'Job Position',
      company: 'Company',
      description: (pageText || '').substring(0, 200),
      requirements: [],
      skills: [],
      hasApplicationForm: text.includes('apply') || text.includes('submit'),
      applicationFormType: 'unknown',
    };
  }

  _normalizeResumeSourceText(text) {
    return String(text || '')
      .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  _cleanGeneratedResumeText(text) {
    return String(text || '')
      .replace(/^```(?:text)?\s*/i, '')
      .replace(/```$/i, '')
      .replace(/\*\*/g, '')
      .replace(/[•●▪○◦]/g, '-')
      .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  _safeProfessionalUrl(url) {
    if (!url) return null;
    const u = String(url).trim();
    if (/linkedin\.com/i.test(u) || /github\.com/i.test(u)) return u;
    return null;
  }

  _fallbackATSResumeText(userData, jobData) {
    const jobTitle = jobData.job_title || jobData.title || userData.jobRole || 'Target Role';
    const company = jobData.employer_name || jobData.company || 'Target Company';
    const safeLinkedIn = this._safeProfessionalUrl(userData.linkedinProfile);
    const allSkills = (userData.keySkills || []).filter(Boolean);

    const originalResume = this._normalizeResumeSourceText(userData.parsedResumeText || '');
    const contactLine = [userData.email, userData.phone, safeLinkedIn].filter(Boolean).join(' | ');
    const sections = [
      `${userData.fullName || 'Candidate'}`,
      contactLine,
      '',
      'PROFESSIONAL SUMMARY',
      `${userData.jobRole || 'Professional'} targeting the ${jobTitle} role at ${company}. ${userData.experience ? `Experience: ${userData.experience}.` : ''} ${userData.education ? `Education: ${userData.education}.` : ''}`.trim(),
    ];

    if (allSkills.length > 0) {
      sections.push('', 'SKILLS', allSkills.join(', '));
    }

    if (originalResume) {
      sections.push('', 'PROFESSIONAL EXPERIENCE', originalResume.substring(0, 8000));
    } else if (userData.experience) {
      sections.push('', 'PROFESSIONAL EXPERIENCE', userData.experience);
    }

    if (userData.education) {
      sections.push('', 'EDUCATION', userData.education);
    }

    return sections.filter((line, index, arr) => !(line === '' && arr[index - 1] === '')).join('\n');
  }
}

module.exports = new AIService();
