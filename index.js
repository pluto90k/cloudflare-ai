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
        const debugInfo = [];
        let currentOffset = startTime;
        let detectedLanguage = "";
        let effectiveLanguage = language;
        let lastTranscription = "";

        // Get context from previous group if available
        if (groupIndex > 0) {
            try {
                const prevKey = `sub:${jobId}:${groupIndex - 1}`;
                const prevData = await env.SUBTITLE_KV.get(prevKey);
                if (prevData) {
                    const prevSegments = JSON.parse(prevData);
                    if (prevSegments.length > 0) {
                        lastTranscription = prevSegments[prevSegments.length - 1].text;
                    }
                }
            } catch (e) {
                console.error("Failed to fetch cross-group context:", e);
                debugInfo.push({ event: "fetch_context_error", message: e.message });
            }
        }

        const CHUNK_SIZE = 3; // 3 segments = ~30 seconds of audio
        for (let i = 0; i < tsUrls.length; i += CHUNK_SIZE) {
            const batchUrls = tsUrls.slice(i, i + CHUNK_SIZE);
            const chunks = [];
            const batchDebug = { batchStartOffset: currentOffset, urls: batchUrls.length };

            for (const tsUrl of batchUrls) {
                try {
                    const res = await fetch(tsUrl);
                    if (res.ok) {
                        chunks.push(new Uint8Array(await res.arrayBuffer()));
                    } else {
                        batchDebug.fetchError = `Failed to fetch ${tsUrl} with status ${res.status}`;
                    }
                } catch (e) {
                    batchDebug.fetchError = `Fetch error for ${tsUrl}: ${e.message}`;
                }
            }

            if (chunks.length === 0) {
                batchDebug.status = "No chunks fetched";
                debugInfo.push(batchDebug);
                currentOffset += batchUrls.length * 10;
                continue;
            }

            // Merge chunks for this batch
            const totalSize = chunks.reduce((acc, c) => acc + c.length, 0);
            const mergedAudio = new Uint8Array(totalSize);
            let offset = 0;
            for (const chunk of chunks) {
                mergedAudio.set(chunk, offset);
                offset += chunk.length;
            }

            const aiOptions = {
                audio: Array.from(mergedAudio), // Pass as standard array
                task: 'transcribe',
                temperature: 0.0,
                vad_filter: false
            };
            if (effectiveLanguage) aiOptions.language = effectiveLanguage;
            if (lastTranscription) aiOptions.initial_prompt = lastTranscription;

            batchDebug.initialPrompt = lastTranscription;

            // Step 1: Try Large V3 Turbo
            let aiResponse = await env.AI.run('@cf/openai/whisper-large-v3-turbo', aiOptions).catch((e) => {
                batchDebug.v3Error = e.message;
                return null;
            });

            // Step 2: Fallback to standard
            if (!aiResponse || (!aiResponse.segments && !aiResponse.text)) {
                aiResponse = await env.AI.run('@cf/openai/whisper', aiOptions).catch((e) => {
                    batchDebug.standardError = e.message;
                    return null;
                });
            }

            if (aiResponse) {
                const segments = aiResponse.segments || [];
                const text = aiResponse.text || "";

                batchDebug.status = "success";
                batchDebug.receivedSegments = segments.length;
                batchDebug.receivedText = text;

                if (text.trim()) {
                    lastTranscription = text.trim();
                }

                // Language discovery
                if (!detectedLanguage) {
                    const langData = aiResponse.language || (aiResponse.transcription_info && aiResponse.transcription_info.language);
                    if (langData) {
                        detectedLanguage = langData;
                        if (!effectiveLanguage) effectiveLanguage = langData; // Lock language
                    }
                }

                if (segments.length > 0) {
                    segments.forEach(seg => {
                        allSegments.push({
                            ...seg,
                            start: seg.start + currentOffset,
                            end: seg.end + currentOffset
                        });
                    });
                } else if (text.trim().length > 1) {
                    allSegments.push({
                        start: currentOffset,
                        end: currentOffset + (batchUrls.length * 10),
                        text: text.trim()
                    });
                }
            } else {
                batchDebug.status = "failed_entirely";
            }
            debugInfo.push(batchDebug);
            currentOffset += batchUrls.length * 10;
        }

        if (allSegments.length === 0) {
            return new Response(JSON.stringify({
                success: true,
                message: 'No speech recognized',
                debug: debugInfo
            }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const kvKey = `sub:${jobId}:${groupIndex}`;
        await env.SUBTITLE_KV.put(kvKey, JSON.stringify(allSegments));

        return new Response(JSON.stringify({
            success: true,
            key: kvKey,
            detectedLanguage: detectedLanguage || language || "unknown",
            segmentCount: allSegments.length,
            debug: debugInfo
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
