export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (request.method === 'POST' && url.pathname === '/process-group') {
            return await handleProcessGroup(request, env);
        }

        if (request.method === 'GET' && url.pathname === '/get-final-vtt') {
            return await handleGetFinalVtt(request, env);
        }

        return new Response('Not Found', { status: 404 });
    }
};

async function handleProcessGroup(request, env) {
    try {
        const body = await request.json();
        const { jobId, groupIndex, startTime, tsUrls, language } = body;

        if (!jobId || groupIndex === undefined || startTime === undefined || !tsUrls) {
            return new Response('Missing parameters', { status: 400 });
        }

        const allSegments = [];
        let currentOffset = startTime;
        let detectedLanguage = "";

        for (const tsUrl of tsUrls) {
            try {
                const response = await fetch(tsUrl);
                if (!response.ok) {
                    currentOffset += 10;
                    continue;
                }

                const arrayBuffer = await response.arrayBuffer();
                const audioData = new Uint8Array(arrayBuffer);
                const audioArray = Array.from(audioData);

                const aiOptions = {
                    audio: audioArray,
                    task: 'transcribe',
                    temperature: 0.0,
                    vad_filter: false
                };
                if (language) aiOptions.language = language;

                // Step 1: Try Large V3 Turbo
                let aiResponse = await env.AI.run('@cf/openai/whisper-large-v3-turbo', aiOptions).catch(() => null);

                // Step 2: Fallback to standard
                if (!aiResponse || (!aiResponse.segments && !aiResponse.text)) {
                    aiResponse = await env.AI.run('@cf/openai/whisper', aiOptions).catch(() => null);
                }

                if (aiResponse) {
                    const segments = aiResponse.segments || [];
                    const text = aiResponse.text || "";

                    // Exhaustive language discovery
                    if (!detectedLanguage) {
                        if (aiResponse.language) detectedLanguage = aiResponse.language;
                        else if (aiResponse.transcription_info && aiResponse.transcription_info.language) detectedLanguage = aiResponse.transcription_info.language;
                    }

                    const isHallucination = (t) => {
                        if (!t || t.trim().length <= 1) return true;
                        const trimmed = t.trim();
                        // 1. Specific phrase loop (Japanese/Hindi hallucinations common in Whisper)
                        if (trimmed.includes("やっぱり") && trimmed.length > 30) return true;
                        if (trimmed.includes("लाँवाँ") && trimmed.length > 30) return true;

                        // 2. High repetition word count
                        const words = trimmed.split(/\s+/);
                        if (words.length > 8) {
                            const uniqueWords = new Set(words);
                            if (uniqueWords.size < words.length / 3) return true;
                        }

                        // 3. Long string with very few unique characters (common in loops)
                        if (trimmed.length > 100) {
                            const uniqueChars = new Set(trimmed.replace(/\s+/g, "").split(""));
                            if (uniqueChars.size < 10) return true;
                        }

                        return false;
                    };

                    if (segments.length > 0) {
                        segments.forEach(seg => {
                            if (isHallucination(seg.text)) return;

                            allSegments.push({
                                ...seg,
                                start: (seg.start || 0) + currentOffset,
                                end: (seg.end || 0) + currentOffset
                            });
                        });
                    } else if (text.trim().length > 1) {
                        if (!isHallucination(text)) {
                            allSegments.push({
                                start: currentOffset,
                                end: currentOffset + 10,
                                text: text.trim()
                            });
                        }
                    }
                }
            } catch (e) {
                console.error(`Segment error for ${tsUrl}:`, e);
            }
            currentOffset += 10;
        }

        if (allSegments.length === 0) {
            return new Response(JSON.stringify({
                success: true,
                message: 'No speech recognized'
            }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const kvKey = `sub:${jobId}:${groupIndex}`;
        await env.SUBTITLE_KV.put(kvKey, JSON.stringify(allSegments));

        return new Response(JSON.stringify({
            success: true,
            key: kvKey,
            detectedLanguage: detectedLanguage || language || "unknown"
        }), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (error) {
        return new Response(error.message, { status: 500 });
    }
}

async function handleGetFinalVtt(request, env) {
    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get('jobId');

    if (!jobId) {
        return new Response('Missing jobId', { status: 400 });
    }

    // List all keys for this jobId
    const prefix = `sub:${jobId}:`;
    const list = await env.SUBTITLE_KV.list({ prefix });

    // Sort keys by groupIndex
    const sortedKeys = list.keys.sort((a, b) => {
        const indexA = parseInt(a.name.split(':').pop());
        const indexB = parseInt(b.name.split(':').pop());
        return indexA - indexB;
    });

    let vttContent = "WEBVTT\n\n";

    for (const key of sortedKeys) {
        const data = await env.SUBTITLE_KV.get(key.name);
        if (data) {
            const segments = JSON.parse(data);
            segments.forEach(segment => {
                vttContent += `${formatVttTime(segment.start)} --> ${formatVttTime(segment.end)}\n`;
                vttContent += `${segment.text.trim()}\n\n`;
            });
        }
    }

    return new Response(vttContent, {
        headers: {
            'Content-Type': 'text/vtt',
            'Content-Disposition': `attachment; filename="subtitles_${jobId}.vtt"`
        }
    });
}

function formatVttTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}
