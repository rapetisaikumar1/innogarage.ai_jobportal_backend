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

  /** Generate ATS-friendly plain-text resume content for an external/saved job */
  async generateATSResumeText(userData, jobData) {
    const candidateResume = this._normalizeResumeSourceText(userData.parsedResumeText || '');
    const jobTitle = jobData.job_title || jobData.title || userData.jobRole || 'Target Role';
    const company = jobData.employer_name || jobData.company || 'Target Company';
    const jobDescription = (jobData.jd || jobData.description || '').trim();
    const safeLinkedIn = this._safeProfessionalUrl(userData.linkedinProfile);

    if (!candidateResume && !(userData.experience || userData.education || (userData.keySkills || []).length > 0)) {
      return { text: this._fallbackATSResumeText(userData, jobData), provider: 'fallback' };
    }

    if (!this.enabled || this._quotaExhausted) {
      return { text: this._fallbackATSResumeText(userData, jobData), provider: 'fallback' };
    }

    const prompt = `You are an expert resume writer and senior technical recruiter.
Your task: take the candidate's ORIGINAL uploaded resume and produce an enhanced version tailored to the target job.
The output must be the candidate's OWN resume — same structure, same content — with targeted additions for the JD.

CRITICAL RULES (follow all strictly):

1. FORMAT PRESERVATION — MANDATORY
   - Identify every section heading in the original resume (e.g. PROFESSIONAL SUMMARY, CORE SKILLS, PROFESSIONAL EXPERIENCE, CERTIFICATIONS, EDUCATION, etc.).
   - Output EXACTLY those headings in EXACTLY the same order. Do NOT rename, merge, reorder, or skip any section.
   - Do NOT add any new section that is not in the original (no "ATS KEYWORDS", no "KEY ACHIEVEMENTS", no "PROJECTS" unless already present).
   - The structure of the output must be a mirror of the original structure.

2. PRESERVE ALL ORIGINAL CONTENT — MANDATORY
   - Copy EVERY bullet point, sentence, and line from the original resume into the output exactly as written.
   - Do NOT remove, shorten, or replace any bullet point from the original.
   - Do NOT change any job title, employer name, company, date, degree, certification, or location.
   - Do NOT change or remove any skill listed in the original resume.
   - The output must contain ALL the content from the original resume plus additions.

3. ADD JD-RELEVANT CONTENT — ADDITIVE ONLY
   - After copying original bullets for each role, you may ADD 1–2 new bullet points per role that highlight skills or responsibilities from the target JD that are genuinely relevant to that role.
   - For skills/tools sections: you may ADD a few JD-relevant skills/technologies at the end IF they are plausible given the candidate's background — do NOT invent skills.
   - In the PROFESSIONAL SUMMARY (or equivalent first section): you may rewrite the summary to 3-4 sentences that align the candidate's real background to the target role — this is the ONLY section where rewriting (not just adding) is allowed.
   - Do NOT invent new employers, projects, certifications, metrics, or achievements not in the original resume.
   - Do NOT fabricate any numbers, tools, or technologies that are not present in the original.

4. NO CONTACT HEADER IN OUTPUT
   - Do NOT output the candidate's name, phone, email, location, or any URL as a header block at the top.
   - The resume display system renders the contact header separately.
   - Begin the output DIRECTLY with the first section heading (e.g. PROFESSIONAL SUMMARY). No blank lines before it.

5. OUTPUT FORMAT
   - Plain text only. No markdown, **, code fences, tables, emojis, or decorative symbols.
   - Every bullet starts with "- ". Use bullet points for Experience, Skills, Certifications, and Education entries.
   - Clean readable lines. No PDF glyphs, control characters, or random symbols.
   - The output should be at least as long as the original resume, ideally 800–1200 words.

Candidate Profile:
- Name: ${userData.fullName || 'Candidate'}
- Email: ${userData.email || 'Not provided'}
- Phone: ${userData.phone || 'Not provided'}${safeLinkedIn ? `\n- LinkedIn: ${safeLinkedIn}` : ''}
- Target Role: ${userData.jobRole || 'Not provided'}
- Skills: ${(userData.keySkills || []).join(', ') || 'Not provided'}
- Experience: ${userData.experience || 'Not provided'}
- Education: ${userData.education || 'Not provided'}

Candidate Original Uploaded Resume:
${candidateResume || 'Not provided — use profile data only'}

Target Job:
- Title: ${jobTitle}
- Company: ${company}
- Description:
${jobDescription || 'Not provided'}

Return the full tailored resume as plain text only. Start IMMEDIATELY with the first section heading — no name, no contact, no header lines before it. Do not include any explanations or labels before or after the resume.`;

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
