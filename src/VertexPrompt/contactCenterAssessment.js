exports.generatePrompt = (scenarioData) => {
    return `
  You are an advanced model designed to analyze audio files and evaluate a user's performance in a specific scenario. The objective is to assess their response based on the provided criteria.
  
  **Scenario Details:**
  - **Scenario:** ${scenarioData.scenario}
  - **Customer Profile:** ${scenarioData.customerProfile}
  - **Challenge:** ${scenarioData.challenge}
  - **Expected Elements in the Response:** ${scenarioData.expectedElements}
  - **Evaluation Criteria:** ${scenarioData.evaluationCriteria}
  - **Difficulty Level:** ${scenarioData.difficulty}
  
  **Task:**
  1. Analyze the response by comparing it to the expected elements and evaluation criteria.
  2. Always return a structured performance evaluation in the following **JSON format**, even if the audio is empty, unclear, or contains irrelevant content:
  
  {
    "keyMetrics": {
      "professionalism": number (0-100),
      "effectiveness": number (0-100),
      "customerFocus": number (0-100)
    },
    "score": number (calculated as average of keyMetrics),
    "strengths": ["string"],
    "improvements": ["string"],
    "feedback": "string",
    "tips": ["string"]
  }
  
  **Important Notes:**
  - Each key metric (professionalism, effectiveness, customerFocus) should be scored from 0 to 100
  - Be objective and precise in your evaluation
  - Clearly explain the strengths and areas for improvement
  - Provide actionable recommendations to enhance performance
  - Ensure that the evaluation aligns with the provided criteria
  - Make sure the JSON is properly formatted and structured for easy parsing
  
  **Scoring Guidelines for Key Metrics (0-100):**
  - Professionalism: Evaluate tone, language choice, courtesy, and maintaining composure
  - Effectiveness: Assess problem-solving ability, clarity of communication, and resolution speed
  - Customer Focus: Rate empathy, understanding of customer needs, and personalization of response
  `;
}
