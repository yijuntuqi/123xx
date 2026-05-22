const express = require('express');
const path = require('path');
const axios = require('axios');
const multer = require('multer');
const csv = require('csv-parse');
const XLSX = require('xlsx');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const { testConnection, userDB, fileDB, analysisDB } = require('./lib/db');

const app = express();
const PORT = process.env.PORT || 3000;

// 配置文件上传
const upload = multer({ 
    dest: 'uploads/',
    limits: { fileSize: 10 * 1024 * 1024 }
});

// 中间件
app.use(express.json());
app.use(express.static('public'));

const JWT_SECRET = process.env.JWT_SECRET || 'ai-analyst-secret-key-2024';

// ============ 用户认证 ============
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        const existingUser = await userDB.findByEmail(email);
        if (existingUser) {
            return res.status(400).json({ error: '该邮箱已注册' });
        }
        const passwordHash = await bcrypt.hash(password, 10);
        const user = await userDB.createUser(username, email, passwordHash);
        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ success: true, user, token });
    } catch (error) {
        res.status(500).json({ error: '注册失败' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await userDB.findByEmail(email);
        if (!user) return res.status(401).json({ error: '邮箱或密码错误' });
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) return res.status(401).json({ error: '邮箱或密码错误' });
        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ success: true, user: { id: user.id, username: user.username, email: user.email, plan_type: user.plan_type }, token });
    } catch (error) {
        res.status(500).json({ error: '登录失败' });
    }
});

// ============ 文件上传 ============
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        const userId = req.body.userId || 1;
        const file = req.file;
        let data = [];
        let fileType = '';
        
        if (file.originalname.endsWith('.csv')) {
            fileType = 'csv';
            const content = require('fs').readFileSync(file.path, 'utf-8');
            data = await new Promise((resolve, reject) => {
                csv.parse(content, { columns: true, skip_empty_lines: true }, (err, records) => {
                    if (err) reject(err);
                    resolve(records);
                });
            });
        } else if (file.originalname.match(/\.xlsx?$/)) {
            fileType = 'excel';
            const workbook = XLSX.readFile(file.path);
            data = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
        } else if (file.originalname.endsWith('.json')) {
            fileType = 'json';
            data = JSON.parse(require('fs').readFileSync(file.path, 'utf-8'));
        }
        
        const columnsInfo = data.length > 0 ? Object.keys(data[0]).map(col => ({
            name: col,
            type: typeof data[0][col]
        })) : [];
        
        const fileInfo = {
            fileName: file.originalname,
            fileType,
            fileSize: file.size,
            rowCount: data.length,
            columnCount: columnsInfo.length,
            columnsInfo,
            sampleData: data.slice(0, 5)
        };
        
        const savedFile = await fileDB.saveFileInfo(userId, fileInfo);
        
        // 缓存数据
        global.dataCache = global.dataCache || {};
        global.dataCache[savedFile.id] = data;
        
        res.json({ success: true, file: savedFile });
    } catch (error) {
        res.status(500).json({ error: '文件处理失败' });
    }
});

// ============ 获取文件列表 ============
app.get('/api/files/:userId', async (req, res) => {
    try {
        const files = await fileDB.getUserFiles(req.params.userId);
        res.json({ success: true, files });
    } catch (error) {
        res.status(500).json({ error: '获取文件失败' });
    }
});

// ============ AI分析 ============
app.post('/api/analyze', async (req, res) => {
    try {
        const { fileId, query, userId } = req.body;
        const fileInfo = await fileDB.getFile(fileId);
        const data = global.dataCache?.[fileId] || [];
        
        if (!fileInfo) return res.status(404).json({ error: '文件不存在' });
        
        const prompt = `你是一个专业的数据分析师。请分析以下数据并回答用户问题。

数据文件：${fileInfo.file_name}
数据规模：${fileInfo.row_count}行 × ${fileInfo.column_count}列
列信息：${JSON.stringify(fileInfo.columns_info)}
数据样本(前5行)：${JSON.stringify(data.slice(0, 5))}

用户问题：${query || '请给出数据概览和关键发现'}

请提供：
1. 数据分析结果
2. 发现的关键洞察
3. 推荐的可视化方案(JSON格式)：
{
  "type": "bar/pie/line",
  "title": "图表标题",
  "labels": ["标签1", "标签2"],
  "data": [数值1, 数值2]
}`;

        const aiResponse = await callAI(prompt);
        
        // 提取图表配置
        let chartConfig = null;
        const jsonMatch = aiResponse.match(/\{[\s\S]*"type"[\s\S]*\}/);
        if (jsonMatch) {
            try {
                chartConfig = JSON.parse(jsonMatch[0]);
            } catch(e) {}
        }
        
        await analysisDB.saveAnalysis(userId || 1, {
            fileId, queryText: query, analysisType: 'analysis',
            aiResponse, insights: { summary: aiResponse.split('\n')[0] },
            chartConfig
        });
        
        res.json({ success: true, analysis: aiResponse, chartConfig, insights: { summary: aiResponse.split('\n')[0] } });
    } catch (error) {
        res.status(500).json({ error: '分析失败' });
    }
});

async function callAI(prompt) {
    try {
        const res = await axios.post(process.env.CHATANYWHERE_API_URL, {
            model: "gpt-3.5-turbo",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.7
        }, {
            headers: { 'Authorization': `Bearer ${process.env.CHATANYWHERE_API_KEY}`, 'Content-Type': 'application/json' }
        });
        return res.data.choices[0].message.content;
    } catch(e) {
        const res = await axios.post(`${process.env.KIMI_BASE_URL}/chat/completions`, {
            model: process.env.KIMI_MODEL,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.7
        }, {
            headers: { 'Authorization': `Bearer ${process.env.KIMI_API_KEY}`, 'Content-Type': 'application/json' }
        });
        return res.data.choices[0].message.content;
    }
}

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`AI数据分析师运行在 http://localhost:${PORT}`);
});