const { neon } = require('@neondatabase/serverless');

// 创建数据库连接
const sql = neon(process.env.DATABASE_URL);

// 测试数据库连接
async function testConnection() {
    try {
        const result = await sql`SELECT NOW()`;
        console.log('数据库连接成功:', result[0]);
        return true;
    } catch (error) {
        console.error('数据库连接失败:', error);
        return false;
    }
}

// 用户相关操作
const userDB = {
    // 创建用户
    async createUser(username, email, passwordHash) {
        try {
            const result = await sql`
                INSERT INTO users (username, email, password_hash)
                VALUES (${username}, ${email}, ${passwordHash})
                RETURNING id, username, email, plan_type, created_at
            `;
            return result[0];
        } catch (error) {
            throw error;
        }
    },

    // 通过邮箱查找用户
    async findByEmail(email) {
        const result = await sql`
            SELECT * FROM users WHERE email = ${email}
        `;
        return result[0];
    },

    // 获取用户信息
    async getUser(userId) {
        const result = await sql`
            SELECT id, username, email, plan_type, created_at 
            FROM users WHERE id = ${userId}
        `;
        return result[0];
    }
};

// 数据文件相关操作
const fileDB = {
    // 保存文件信息
    async saveFileInfo(userId, fileInfo) {
        const result = await sql`
            INSERT INTO data_files (user_id, file_name, file_type, file_size, 
                row_count, column_count, columns_info, sample_data)
            VALUES (${userId}, ${fileInfo.fileName}, ${fileInfo.fileType}, 
                ${fileInfo.fileSize}, ${fileInfo.rowCount}, ${fileInfo.columnCount},
                ${JSON.stringify(fileInfo.columnsInfo)}, ${JSON.stringify(fileInfo.sampleData)})
            RETURNING *
        `;
        return result[0];
    },

    // 获取用户的文件列表
    async getUserFiles(userId) {
        const result = await sql`
            SELECT * FROM data_files 
            WHERE user_id = ${userId} 
            ORDER BY created_at DESC
        `;
        return result;
    },

    // 获取文件详情
    async getFile(fileId) {
        const result = await sql`
            SELECT * FROM data_files WHERE id = ${fileId}
        `;
        return result[0];
    }
};

// 分析记录相关操作
const analysisDB = {
    // 保存分析记录
    async saveAnalysis(userId, analysisData) {
        const result = await sql`
            INSERT INTO analysis_records (user_id, file_id, query_text, 
                analysis_type, ai_response, insights, chart_config)
            VALUES (${userId}, ${analysisData.fileId}, ${analysisData.queryText},
                ${analysisData.analysisType}, ${analysisData.aiResponse},
                ${JSON.stringify(analysisData.insights)}, 
                ${JSON.stringify(analysisData.chartConfig)})
            RETURNING *
        `;
        return result[0];
    },

    // 获取分析历史
    async getHistory(userId, limit = 10) {
        const result = await sql`
            SELECT ar.*, df.file_name 
            FROM analysis_records ar
            JOIN data_files df ON ar.file_id = df.id
            WHERE ar.user_id = ${userId}
            ORDER BY ar.created_at DESC
            LIMIT ${limit}
        `;
        return result;
    }
};

module.exports = {
    testConnection,
    userDB,
    fileDB,
    analysisDB
};