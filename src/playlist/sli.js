async function parseSliFile(file) {
    try {
        const text = await file.text();
        const fromMatch = text.match(/\bFrom\s*=\s*(\d+)/i);
        const toMatch = text.match(/\bTo\s*=\s*(\d+)/i);
        if (!fromMatch || !toMatch) return { status: 'invalid', error: '缺少 From 或 To' };
        const fromSamples = Number(fromMatch[1]);
        const toSamples = Number(toMatch[1]);
        if (!Number.isSafeInteger(fromSamples) || !Number.isSafeInteger(toSamples)) return { status: 'invalid', error: '采样点超出安全整数范围' };
        if (toSamples < 0 || fromSamples <= toSamples) return { status: 'invalid', error: '需要满足 From > To >= 0' };
        return { status: 'valid', fromSamples, toSamples };
    } catch (error) {
        return { status: 'invalid', error: `读取失败: ${error?.message || error}` };
    }
}

export { parseSliFile };
