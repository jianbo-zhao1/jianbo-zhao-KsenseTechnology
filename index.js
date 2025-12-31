require('dotenv').config();

const API_KEY = process.env.API_KEY;
const BASE_URL = "https://assessment.ksensetech.com/api";

if (!API_KEY) {
    console.error("Error: API_KEY is missing.");
    process.exit(1);
}

const CONFIG = {
    maxRetries: 5,
    initialDelay: 1000,
    pageLimit: 20
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithRetry(endpoint, options = {}) {
    let attempt = 0;
    let url = `${BASE_URL}${endpoint}`;

    const headers = {
        'x-api-key': API_KEY,
        'Content-Type': 'application/json',
        ...options.headers
    };

    while (attempt < CONFIG.maxRetries) {
        try {
            const response = await fetch(url, { ...options, headers });
            if (response.ok) {
                return await response.json();
            }
            //Handle rate limiting
            if (response.status === 429) {
                console.warn(`Rate limit hit. Retrying in ${CONFIG.initialDelay * (attempt + 1)}ms...`);
                await sleep(CONFIG.initialDelay * (attempt + 1));
                attempt++;
                continue;
            }
            //Handle server errors
            if (response.status >= 500) {
                console.warn(`Server error (${response.status}). Retrying...`);
                await sleep(CONFIG.initialDelay * Math.pow(2, attempt));
                attempt++;
                continue;
            }
            //Handle client errors
            const errorText = await response.text();
            throw new Error(`Request failed: ${response.status} ${errorText}`);
        } catch (error) {
            console.error(`Error on attempt ${attempt + 1}: ${error.message}`);
            attempt++;
            if (attempt >= CONFIG.maxRetries) throw error;
            await sleep(CONFIG.initialDelay * Math.pow(2, attempt));
        }
    }
    throw new Error(`Max retries reached for ${url}`);
}

async function getAllPatients() {
    let allPatients = [];
    let page = 1;
    let hasMore = true;

    console.log("Starting patient data download...");

    while (hasMore) {
        const data = await fetchWithRetry(`/patients?page=${page}&limit=${CONFIG.pageLimit}`);
        if (data.data && Array.isArray(data.data)) {
            allPatients = [...allPatients, ...data.data];
            console.log(`Fetched page ${page} (${data.data.length} records). Total so far: ${allPatients.length}`);

            if (data.data.length < CONFIG.pageLimit || !data.pagination?.hasNext) {
                hasMore = false;
            } else {
                page++;
            }
        } else {
            hasMore = false;
        }
    }

    console.log("Download complete.\n");
    return allPatients;
}

function calculateScore(patient) {
    let riskScore = 0;
    let isDataInvalid = false;
    let isFever = false;

    //BP
    if (!patient.blood_pressure || typeof patient.blood_pressure !== 'string' || !patient.blood_pressure.includes('/')) {
        isDataInvalid = true;
    } else {
        const parts = patient.blood_pressure.split('/');
        if (parts.length !== 2 || parts[0].trim() === "" || parts[1].trim() === "") {
            isDataInvalid = true;
        } else {
            const systolic = parseInt(parts[0], 10);
            const diastolic = parseInt(parts[1], 10);

            if (isNaN(systolic) || isNaN(diastolic)) {
                isDataInvalid = true;
            } else {
                let sTier = 0;
                if (systolic >= 140) sTier = 3;
                else if (systolic >= 130) sTier = 2;
                else if (systolic >= 120) sTier = 1;

                let dTier = 0;
                if (diastolic >= 90) dTier = 3;
                else if (diastolic >= 80) dTier = 2;
                riskScore += Math.max(sTier, dTier);
            }
        }
    }

    //Temp
    const rawTemp = patient.temperature;
    if (rawTemp === null || rawTemp === undefined || String(rawTemp).trim() === "" || isNaN(Number(rawTemp))) {
        isDataInvalid = true;
    } else {
        const temp = Number(rawTemp);
        if (temp >= 99.6) isFever = true;
        if (temp >= 101.0) riskScore += 2;
        else if (temp >= 99.6) riskScore += 1;
    }

    //Age
    const rawAge = patient.age;
    const ageNum = parseInt(rawAge, 10);
    if (rawAge === null || rawAge === undefined || String(rawAge).trim() === "" || isNaN(ageNum)) {
        isDataInvalid = true;
    } else {
        if (ageNum > 65) riskScore += 2;
        else if (ageNum >= 40) riskScore += 1;
    }

    return {
        id: patient.patient_id,
        totalRisk: riskScore,
        isFever: isFever,
        isInvalid: isDataInvalid
    };
}

async function runAssessment() {
    try {
        const patients = await getAllPatients();

        const high_risk_patients = [];
        const fever_patients = [];
        const data_quality_issues = [];

        patients.forEach(p => {
            const result = calculateScore(p);

            if (result.isInvalid) {
                data_quality_issues.push(result.id);
            }

            if (result.totalRisk >= 4 && !result.isInvalid) {
                high_risk_patients.push(result.id);
            }

            if (result.isFever) {
                fever_patients.push(result.id);
            }
        });

        const results = {
            high_risk_patients,
            fever_patients,
            data_quality_issues
        };

        console.log("Analysis Results:");
        console.log(`   High Risk: ${high_risk_patients.length}`);
        console.log(`   Fever:     ${fever_patients.length}`);

        console.log("\nSubmitting results...");
        const data = await fetchWithRetry('/submit-assessment', {
            method: 'POST',
            body: JSON.stringify(results)
        });
        console.log("\nSubmission Successful!");
        console.log(JSON.stringify(data, null, 2));

    } catch (error) {
        console.error("\nFatal Error:", error.message);
    }
}

runAssessment();