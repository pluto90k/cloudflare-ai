export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // Process TS URLs list (Yesterday's successful method)
        if (request.method === 'POST' && url.pathname === '/process-ts') {
            return await handleProcessTs(request, env);
        }


        if (request.method === 'GET' && url.pathname === '/status') {
            return await handleStatus(request, env);
        }

        if (request.method === 'GET' && url.pathname === '/get-final-vtt') {
            return await handleGetFinalVtt(request, env);
        }

        return new Response('Not Found', { status: 404 });
    },

    async queue(batch, env) {
        for (const message of batch.messages) {
            await processQueueMessage(message, env);
        }
    }
};

async function handleProcessTs(request, env) {
    try {
        const body = await request.json();
        const { jobId, tsUrls, language, startTime } = body;

        if (!tsUrls || !tsUrls.length) {
            return new Response('Missing tsUrls', { status: 400 });
        }

        const id = jobId || crypto.randomUUID();

        // Register job to Queue
        await env.SUBTITLE_QUEUE.send({
            type: 'ts-list',
            jobId: id,
            tsUrls,
            language,
            startTime: startTime || 0
        });

        // Initialize D1 status
        await env.SUBTITLE_DB.prepare(
            "INSERT INTO jobs (id, status, created_at) VALUES (?, 'processing', ?)"
        ).bind(id, new Date().toISOString()).run();

        return new Response(JSON.stringify({
            success: true,
            jobId: id,
            message: 'TS list processing started'
        }), { headers: { 'Content-Type': 'application/json' } });

    } catch (e) {
        return new Response(e.message, { status: 500 });
    }
}

async function processQueueMessage(message, env) {
    const { jobId, tsUrls, language, startTime } = message.body;
    let lastTranscription = "";
    let currentOffset = startTime || 0;
    let allText = "";

    try {
        const CHUNK_SIZE = 3; // 3 segments = ~30s (Yesterday's optimum)

        for (let i = 0; i < tsUrls.length; i += CHUNK_SIZE) {
            const batchUrls = tsUrls.slice(i, i + CHUNK_SIZE);
            const chunks = [];

            // Download segments
            for (const tsUrl of batchUrls) {
                try {
                    const res = await fetch(tsUrl);
                    if (res.ok) chunks.push(new Uint8Array(await res.arrayBuffer()));
                } catch (e) {
                    console.error(`Fetch error ${tsUrl}: ${e.message}`);
                }
            }

            if (chunks.length === 0) {
                currentOffset += batchUrls.length * 10;
                continue;
            }

            // Merge for this chunk
            const totalSize = chunks.reduce((acc, c) => acc + c.length, 0);
            const mergedAudio = new Uint8Array(totalSize);
            let offset = 0;
            for (const chunk of chunks) {
                mergedAudio.set(chunk, offset);
                offset += chunk.length;
            }

            const aiOptions = {
                audio: Array.from(mergedAudio),
                task: 'transcribe',
                language: language || undefined,
                initial_prompt: lastTranscription || undefined
            };

            // Large V3 Turbo with Fallback
            let aiResponse = await env.AI.run('@cf/openai/whisper-large-v3-turbo', aiOptions).catch(() => null);
            if (!aiResponse || !aiResponse.text) {
                aiResponse = await env.AI.run('@cf/openai/whisper', aiOptions).catch(() => null);
            }

            if (aiResponse && aiResponse.text) {
                const cleanText = aiResponse.text.trim();
                allText += (allText ? "\n\n" : "") + cleanText;
                lastTranscription = cleanText; // Context for next chunk
            }

            currentOffset += batchUrls.length * 10;
        }

        // Finalize D1
        await env.SUBTITLE_DB.prepare(
            "UPDATE jobs SET result = ?, status = 'completed', completed_at = ? WHERE id = ?"
        ).bind(allText, new Date().toISOString(), jobId).run();

    } catch (e) {
        console.error(`Queue error ${jobId}:`, e);
        await env.SUBTITLE_DB.prepare(
            "UPDATE jobs SET status = 'failed', error = ? WHERE id = ?"
        ).bind(e.message, jobId).run();
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

    if (!job || !job.result) return new Response('Not ready or not found', { status: 404 });

    // Simple text to VTT conversion for demonstration
    let vttContent = "WEBVTT\n\n00:00:00.000 --> 99:59:59.000\n" + job.result;

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
