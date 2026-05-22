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
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB限制
});

// 中间件
app.use(express.json());
app.use(express.static('public'));

// JWT密钥（生产环境应使用环境变量）
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// ============ 用户认证相关API ============

// 用户注册
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        
        // 检查用户是否已存在
        const existingUser = await userDB.findByEmail(email);
        if (existingUser) {
            return res.status(400).json({ error: '该邮箱已注册' });
        }

        // 加密密码
        const passwordHash = await bcrypt.hash(password, 10);
        const user = await userDB.createUser(username, email, passwordHash);
        
        // 生成JWT token
        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
        
        res.json({ success: true, user, token });
    } catch (error) {
        console.error('注册失败:', error);
        res.status(500).json({ error: '注册失败' });
    }
});

// 用户登录
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await userDB.findByEmail(email);
        
        if (!user) {
            return res.status(401).json({ error: '邮箱或密码错误' });
        }

        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) {
            return res.status(401).json({ error: '邮箱或密码错误' });
        }

        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
        const { password_hash, ...userInfo } = user;
        
        res.json({ success: true, user: userInfo, token });
    } catch (error) {
        console.error('登录失败:', error);
        res.status(500).json({ error: '登录失败' });
    }
});

// ============ 文件上传和数据处理API ============

// 上传数据文件
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        // 验证用户（简化版，实际应解析JWT）
        const userId = req.body.userId || 1; // 临时处理
        
        const file = req.file;
        let data = [];
        let columnsInfo = [];
        let fileType = '';
        
        // 根据文件类型解析
        if (file.originalname.endsWith('.csv')) {
            fileType = 'csv';
            const fileContent = require('fs').readFileSync(file.path, 'utf-8');
            data = await parseCSV(fileContent);
        } else if (file.originalname.endsWith('.xlsx') || file.originalname.endsWith('.xls')) {
            fileType = 'excel';
            const workbook = XLSX.readFile(file.path);
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            data = XLSX.utils.sheet_to_json(sheet);
        } else if (file.originalname.endsWith('.json')) {
            fileType = 'json';
            const fileContent = require('fs').readFileSync(file.path, 'utf-8');
            data = JSON.parse(fileContent);
        }
        
        // 分析数据结构
        if (data.length > 0) {
            columnsInfo = Object.keys(data[0]).map(col => ({
                name: col,
                type: typeof data[0][col],
                sample: data[0][col]
            }));
        }
        
        // 保存文件信息到数据库
        const fileInfo = {
            fileName: file.originalname,
            fileType: fileType,
            fileSize: file.size,
            rowCount: data.length,
            columnCount: columnsInfo.length,
            columnsInfo: columnsInfo,
            sampleData: data.slice(0, 5) // 保存前5行作为样本
        };
        
        const savedFile = await fileDB.saveFileInfo(userId, fileInfo);
        
        // 将完整数据保存到内存或session中（实际项目可用Redis）
        global.dataCache = global.dataCache || {};
        global.dataCache[savedFile.id] = data;
        
        res.json({
            success: true,
            file: savedFile,
            preview: data.slice(0, 10)
        });
    } catch (error) {
        console.error('文件上传失败:', error);
        res.status(500).json({ error: '文件处理失败' });
    }
});

// CSV解析函数
async function parseCSV(content) {
    return new Promise((resolve, reject) => {
        csv.parse(content, {
            columns: true,
            skip_empty_lines: true
        }, (err, records) => {
            if (err) reject(err);
            resolve(records);
        });
    });
}

// ============ AI数据分析API ============

// 智能数据洞察
app.post('/api/analyze', async (req, res) => {
    try {
        const { fileId, query, userId } = req.body;
        
        // 获取文件数据和信息
        const fileInfo = await fileDB.getFile(fileId);
        const data = global.dataCache?.[fileId] || [];
        
        if (!fileInfo || data.length === 0) {
            return res.status(404).json({ error: '文件数据不存在' });
        }
        
        // 构建AI分析prompt
        const analysisPrompt = buildAnalysisPrompt(fileInfo, data, query);
        
        // 调用AI API进行分析
        const aiResponse = await callAIApi(analysisPrompt);
        
        // 解析AI响应，提取可视化配置
        const { insights, chartConfig } = parseAIResponse(aiResponse, fileInfo);
        
        // 保存分析记录
        const analysisRecord = await analysisDB.saveAnalysis(userId, {
            fileId: fileId,
            queryText: query,
            analysisType: 'summary',
            aiResponse: aiResponse,
            insights: insights,
            chartConfig: chartConfig
        });
        
        res.json({
            success: true,
            analysis: aiResponse,
            insights: insights,
            chartConfig: chartConfig,
            recordId: analysisRecord.id
        });
    } catch (error) {
        console.error('分析失败:', error);
        res.status(500).json({ error: '数据分析失败' });
    }
});

// 构建AI分析提示词
function buildAnalysisPrompt(fileInfo, data, query) {
    return `你是一个专业的数据分析师。请分析以下数据并回答用户的问题。

数据信息：
- 文件名：${fileInfo.file_name}
- 总行数：${fileInfo.row_count}
- 列信息：${JSON.stringify(fileInfo.columns_info)}

数据样本（前5行）：
${JSON.stringify(data.slice(0, 5), null, 2)}

用户问题：${query || '请给出这份数据的整体分析和关键发现'}

请提供：
1. 数据概览和关键统计信息
2. 发现的规律和趋势
3. 异常值检测结果
4. 可行的建议
5. 推荐的可视化图表类型（用JSON格式标注）`;
}

// 调用AI API（支持自动切换）
async function callAIApi(prompt) {
    try {
        // 优先使用ChatAnywhere
        const response = await axios.post(process.env.CHATANYWHERE_API_URL, {
            model: "gpt-3.5-turbo",
            messages: [
                { role: "system", content: "你是专业的数据分析师。" },
                { role: "user", content: prompt }
            ],
            temperature: 0.7
        }, {
            headers: {
                'Authorization': `Bearer ${process.env.CHATANYWHERE_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        return response.data.choices[0].message.content;
    } catch (error) {
        // 备用Kimi API
        const kimiResponse = await axios.post(`${process.env.KIMI_BASE_URL}/chat/completions`, {
            model: process.env.KIMI_MODEL,
            messages: [
                { role: "system", content: "你是专业的数据分析师。" },
                { role: "user", content: prompt }
            ],
            temperature: 0.7
        }, {
            headers: {
                'Authorization': `Bearer ${process.env.KIMI_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        return kimiResponse.data.choices[0].message.content;
    }
}

// 解析AI响应
function parseAIResponse(aiResponse, fileInfo) {
    // 简化的解析逻辑
    const insights = {
        summary: aiResponse.split('\n')[0],
        trends: [],
        anomalies: [],
        recommendations: []
    };
    
    // 推荐图表类型
    const chartConfig = {
        type: fileInfo.columns_info.length > 1 ? 'bar' : 'pie',
        title: '数据可视化',
        labels: fileInfo.columns_info.map(col => col.name),
        data: []
    };
    
    return { insights, chartConfig };
}

// ============ 获取分析历史 ============
app.get('/api/history/:userId', async (req, res) => {
    try {
        const history = await analysisDB.getHistory(req.params.userId);
        res.json({ success: true, history });
    } catch (error) {
        res.status(500).json({ error: '获取历史失败' });
    }
});

// 首页路由
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 启动服务器
app.listen(PORT, () => {
    console.log(`AI数据分析师平台运行在 http://localhost:${PORT}`);
});