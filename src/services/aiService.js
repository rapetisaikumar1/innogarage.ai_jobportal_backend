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
    this.model = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash-lite' });
    this.enabled = true;
    this._quotaExhausted = false;
  }

  /** Call Gemini with quota-aware fallback */
  async _generate(prompt) {
    if (this._quotaExhausted) return null;
    try {
      const result = await this.model.generateContent(prompt);
      return result.response.text();
    } catch (err) {
      if (err.message && err.message.includes('429')) {
        this._quotaExhausted = true;
        console.warn('AI quota exhausted — switching to basic mode for remaining calls');
      } else {
        console.error('AI generate error:', err.message);
      }
      return null;
    }
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
}

module.exports = new AIService();
