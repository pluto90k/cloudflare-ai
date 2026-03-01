export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // Upload and trigger background processing
        if (request.method === 'POST' && url.pathname === '/upload') {
            return await handleUpload(request, env);
        }

        if (request.method === 'POST' && url.pathname === '/process-group') {
            return await handleProcessGroup(request, env);
        }

        if (request.method === 'GET' && url.pathname === '/get-final-vtt') {
            return await handleGetFinalVtt(request, env);
        }

        if (request.method === 'GET' && url.pathname === '/status') {
            return await handleStatus(request, env);
        }

        return new Response('Not Found', { status: 404 });
    },

    async queue(batch, env) {
        for (const message of batch.messages) {
            await processQueueMessage(message, env);
        }
    }
};

async function handleUpload(request, env) {
    try {
        const contentType = request.headers.get('content-type') || '';
        if (!contentType.includes('multipart/form-data')) {
            return new Response('Expected multipart/form-data', { status: 400 });
        }

        const formData = await request.formData();
        const file = formData.get('file');
        const language = formData.get('language') || '';

        if (!file) return new Response('No file uploaded', { status: 400 });

        const jobId = crypto.randomUUID();
        const fileName = `${jobId}.file`;

        // Store in R2 (Free Tier: up to 10GB)
        await env.VIDEO_STORAGE.put(fileName, file);

        // Send to Queue for async processing
        await env.SUBTITLE_QUEUE.send({
            jobId,
            fileName,
            language
        });

        // Initialize D1 status
        await env.SUBTITLE_DB.prepare(
            "INSERT INTO jobs (id, status, created_at) VALUES (?, 'processing', ?)"
        ).bind(jobId, new Date().toISOString()).run();

        return new Response(JSON.stringify({
            success: true,
            jobId,
            message: 'Processing started'
        }), { headers: { 'Content-Type': 'application/json' } });

    } catch (e) {
        return new Response(e.message, { status: 500 });
    }
}

async function processQueueMessage(message, env) {
    const { jobId, fileName, language } = message.body;

    try {
        // 1. Get file from R2
        const object = await env.VIDEO_STORAGE.get(fileName);
        if (!object) throw new Error('File not found in R2');

        const audioData = await object.arrayBuffer();

        // 2. Transcribe using Workers AI (Whisper)
        const aiResponse = await env.AI.run('@cf/openai/whisper', {
            audio: Array.from(new Uint8Array(audioData)),
            task: 'transcribe',
            language: language || undefined
        });

        // 3. Save result to D1
        if (aiResponse && aiResponse.text) {
            await env.SUBTITLE_DB.prepare(
                "UPDATE jobs SET result = ?, status = 'completed', completed_at = ? WHERE id = ?"
            ).bind(aiResponse.text, new Date().toISOString(), jobId).run();

            // Also save to KV for backward compatibility if needed
            await env.SUBTITLE_KV.put(`final:${jobId}`, aiResponse.text);
        }

        // 4. IMPORTANT: Auto Cleanup R2 (Free Tier management)
        await env.VIDEO_STORAGE.delete(fileName);

    } catch (e) {
        console.error(`Processing failed for ${jobId}:`, e);
        await env.SUBTITLE_DB.prepare(
            "UPDATE jobs SET status = 'failed', error = ? WHERE id = ?"
        ).bind(e.message, jobId).run();

        // Cleanup even if failed
        await env.VIDEO_STORAGE.delete(fileName);
    }
}

async function handleStatus(request, env) {
    const jobId = new URL(request.url).searchParams.get('jobId');
    if (!jobId) return new Response('Missing jobId', { status: 400 });

    const job = await env.SUBTITLE_DB.prepare(
        "SELECT * FROM jobs WHERE id = ?"
    ).bind(jobId).first();

    return new Response(JSON.stringify(job), {
        headers: { 'Content-Type': 'application/json' }
    });
}

async function handleGetFinalVtt(request, env) {
    const jobId = new URL(request.url).searchParams.get('jobId');
    if (!jobId) return new Response('Missing jobId', { status: 400 });

    const job = await env.SUBTITLE_DB.prepare(
        "SELECT result FROM jobs WHERE id = ?"
    ).bind(jobId).first();

    if (!job || !job.result) return new Response('Subtitles not ready', { status: 404 });

    // Simple text to VTT conversion for demonstration
    let vttContent = "WEBVTT\n\n00:00:00.000 --> 00:05:00.000\n" + job.result;

    // Optional: Final Cleanup D1/KV after download to save space
    // await env.SUBTITLE_DB.prepare("DELETE FROM jobs WHERE id = ?").bind(jobId).run();

    return new Response(vttContent, {
        headers: {
            'Content-Type': 'text/vtt',
            'Content-Disposition': `attachment; filename="subtitles_${jobId}.vtt"`
        }
    });
}

// Keep original logic as helper or legacy if needed
async function handleProcessGroup(request, env) {
    // ... existing handleProcessGroup logic could be kept for compatibility 
    // but the new /upload flow is recommended
    return new Response('Use /upload for non-blocking processing', { status: 400 });
}

function formatVttTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}
