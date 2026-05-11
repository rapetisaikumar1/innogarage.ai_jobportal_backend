-- CreateTable
CREATE TABLE "available_technologies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "available_technologies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "available_technologies_normalizedName_key" ON "available_technologies"("normalizedName");

-- CreateIndex
CREATE INDEX "available_technologies_category_sortOrder_idx" ON "available_technologies"("category", "sortOrder");

-- Seed default available technologies
INSERT INTO "available_technologies" ("id", "name", "normalizedName", "category", "sortOrder", "createdAt", "updatedAt") VALUES
('2b10cc0d-6848-4e35-9cc3-f7fd9b95c11a', 'AEP', 'aep', 'Marketing Automation & Adobe Stack', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('bb6c8e07-09d3-4e22-8174-c5858ea25a27', 'AJO', 'ajo', 'Marketing Automation & Adobe Stack', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('6ce3df0d-8331-4e4e-9d56-5213c975c3ac', 'Adobe Analytics', 'adobe analytics', 'Marketing Automation & Adobe Stack', 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('b1d47b92-7b52-4400-8801-d474d78824ce', 'Adobe Campaign', 'adobe campaign', 'Marketing Automation & Adobe Stack', 4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('4f6c4186-c3ab-4df5-8a2a-75ea5115e1ef', 'Adobe Marketo', 'adobe marketo', 'Marketing Automation & Adobe Stack', 5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('6f5dd84b-d37f-4769-a7aa-0e6110d0b814', 'CRM', 'crm', 'Marketing Automation & Adobe Stack', 6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('0f973748-d37e-4faf-9adf-5fa57d8bb238', 'SFMC', 'sfmc', 'Marketing Automation & Adobe Stack', 7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('f61e4adb-152b-4801-aa2c-d059849f16b0', 'Veeva CRM', 'veeva crm', 'Marketing Automation & Adobe Stack', 8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('77d705c3-1f0b-4474-96b8-52d0853a4618', 'AI', 'ai', 'Data & Analytics / CDP', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('902442ce-7105-4d52-bc8b-a66ec189ef38', 'CDM', 'cdm', 'Data & Analytics / CDP', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('fdaf1045-c5d9-4050-b6cc-401e4de99688', 'DG', 'dg', 'Data & Analytics / CDP', 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('2bc73009-8873-4b67-af1b-c00785a5c5bc', 'EDI', 'edi', 'Data & Analytics / CDP', 4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('ac632927-94db-46b4-9fc1-c7f3d7ece260', 'EHR', 'ehr', 'Data & Analytics / CDP', 5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('9ed935be-e0cc-46d1-afdc-e585b6fe8c9a', 'KDB Developer', 'kdb developer', 'Data & Analytics / CDP', 6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('fdb835a8-791f-4637-bbf4-213ad57e8134', 'Palantir', 'palantir', 'Data & Analytics / CDP', 7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('baa88362-6658-4813-9260-29626c2f86ee', 'CyberArk', 'cyberark', 'Core Engineering & Development', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('46d8d475-a428-4883-ab91-30f39ab9c253', 'Electrical Design Engineer', 'electrical design engineer', 'Core Engineering & Development', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('6f56dc75-d990-402f-a3a1-e74bb257a7d7', 'Electronics Engineer', 'electronics engineer', 'Core Engineering & Development', 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('34143cd4-cf71-4047-bd07-cc6803cfd43c', 'Embedded Systems', 'embedded systems', 'Core Engineering & Development', 4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('19f006dd-4f7a-45d6-8539-08692b7024c5', 'Field Application Engineer', 'field application engineer', 'Core Engineering & Development', 5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('880d9af8-17c7-4213-aa1e-70a8bf2b8028', 'Frontend Engineer (FE)', 'frontend engineer (fe)', 'Core Engineering & Development', 6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('072afe39-4e0c-4f58-a1dc-8ed9e29738e1', 'AWF', 'awf', 'Automation, Testing & Validation', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('969cb357-0c99-43bb-9bb4-0f77c1c5e5f3', 'Automation Engineer', 'automation engineer', 'Automation, Testing & Validation', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('f95909d9-208d-4af9-bc38-8f1da8a0db6b', 'CSV', 'csv', 'Automation, Testing & Validation', 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('fd41e5d5-eb2a-4d64-8d3f-a070e648e0c9', 'Validation', 'validation', 'Automation, Testing & Validation', 4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('0cd0f516-4d0c-4b12-a0f0-78309df17ff0', 'BC', 'bc', 'Infrastructure & Operations', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('0dd034b0-e9c0-4736-bc32-d99c6b3f3df1', 'Data Centre (DC)', 'data centre (dc)', 'Infrastructure & Operations', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('d31158ef-ddf6-4a6d-bb63-56786ca9f4e6', 'ED / EDE', 'ed / ede', 'Infrastructure & Operations', 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('30672d01-f525-46af-8898-0c6e2fb95f07', 'Network Engineer', 'network engineer', 'Infrastructure & Operations', 4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('9c40ee97-1d12-4f58-aa2b-75b221558b21', 'F&O', 'f&o', 'Enterprise Tools & Business Systems', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('6a8185f1-69e7-4359-a2cb-b9197441bb43', 'FinOps Analyst', 'finops analyst', 'Enterprise Tools & Business Systems', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('370a74d3-aafe-42f0-8de2-869333f68718', 'Smartsheet', 'smartsheet', 'Enterprise Tools & Business Systems', 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('87cb747e-b84c-4d5a-b602-086ec5e15472', 'UKG', 'ukg', 'Enterprise Tools & Business Systems', 4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('39d5cc8b-1760-4385-a780-610f66cc8a85', 'VLSI', 'vlsi', 'Semiconductor & Hardware', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('e572564b-d1af-42d7-bb9c-854223c1ebf7', 'AC', 'ac', 'Misc / Other', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('bf9345cd-d87a-4884-b28e-2423355ee50f', 'BFS', 'bfs', 'Misc / Other', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);