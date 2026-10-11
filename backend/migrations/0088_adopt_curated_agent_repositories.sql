-- Frozen launch catalog identifiers, not a blanket conversion of admin imports.
-- Move metadata in place: public URLs, revisions, R2 references, forks and stars survive.
WITH catalog(request_id, repository_url, commit_sha) AS (VALUES
    ('11a411b7-2c99-4aae-8b2e-b84ef60b133e'::uuid, 'https://github.com/Leonxlnx/taste-skill', '18dfc928b135629e0eddfdd445a06400d04ed439'),
    ('0214e00e-3eaf-4a61-b4df-d53a9a74872c'::uuid, 'https://github.com/ayghri/i-have-adhd', '723af7d9afaf43eb871dbcce6129e2bf80de90d5'),
    ('ab327d36-3265-4921-b73c-0726d381b2bd'::uuid, 'https://github.com/blader/humanizer', '225a6f39ac85f76ee48dbad772ea4abe4ed6c9d8'),
    ('9b734dc1-724b-4e8b-8adc-335c5634ce48'::uuid, 'https://github.com/kepano/obsidian-skills', '3ccff5338ea700537839b21900aa5358a0402c98'),
    ('3ac7e843-9c9c-4279-bdf7-f73d2d4b8658'::uuid, 'https://github.com/emilkowalski/skills', 'e8a175de22ae1e49370fc144c1f3bb9aeedf988d'),
    ('adddd574-7cd3-4918-afe0-3121d30e0e55'::uuid, 'https://github.com/virgiliojr94/book-to-skill', 'e180fc46365e8c1aab0120778cc8a40b9515324b'),
    ('e56820de-334e-45b6-bfae-26c446e52b16'::uuid, 'https://github.com/vercel-labs/skills', 'e878c4502674f84094dc27b5ad94ddaf64f22551'),
    ('4343d63d-6e99-42ca-abc9-73fcbe0fb492'::uuid, 'https://github.com/phuryn/pm-skills', '55c8ec095af22a62729937c7f5c85d837ce84306'),
    ('2d230550-4983-49c2-9d03-12a99cd85b77'::uuid, 'https://github.com/cloudflare/security-audit-skill', 'c1c8a8c1471069fb0e188eeaff69b8e8db6564a8'),
    ('55923f2b-f278-49d7-9b93-308e5452d0d8'::uuid, 'https://github.com/nidhinjs/prompt-master', '2bd92518e26bf659e21e3d9ab90573fcf3ddeccb'),
    ('e4b05c7d-4dec-40db-9192-0e47454f75d9'::uuid, 'https://github.com/kangarooking/cangjie-skill', 'a28de55ba881b9928956a55048f743f7a9e3b23e'),
    ('9972bf86-580f-4502-b431-9920ca07924b'::uuid, 'https://github.com/lewislulu/html-ppt-skill', 'fd1629067909ff55b36b905476de4e5f26062a1f'),
    ('958d6868-ac51-4414-8082-52de3f721ea9'::uuid, 'https://github.com/SimoneAvogadro/android-reverse-engineering-skill', '04fe39c7dcc8efa0ce39a331862fb76407d2d9dd'),
    ('7853dd10-ac78-4f3f-87b6-668508eac329'::uuid, 'https://github.com/jakubkrehel/skills', 'd574cc8a576dc24256ad38268b8d03d86724a1b3'),
    ('c144e9fe-771e-4ec5-86be-aa5960f87f15'::uuid, 'https://github.com/lijigang/ljg-skills', '9e75497a950d2cc58ab9e6871f76405144687bd9'),
    ('5d6a92e4-6e54-42a1-bf23-c3b29fc02f40'::uuid, 'https://github.com/alchaincyf/darwin-skill', '8a8b66258e3c45d6ae4aea39719468c6428fcb0a'),
    ('1b678b30-cdba-4a03-8af5-2e7bd5a14b81'::uuid, 'https://github.com/s1dashu/ip-as-logo-skill', 'acb834c717bcd0a487c49732d08397ba280d690b'),
    ('3bca4d34-1d5c-41ed-8982-6db3dd0f312c'::uuid, 'https://github.com/Hisn00w/ASu-skills', '4306ec6aa1722b16ee8ff9a75a414eb5e04541ff'),
    ('82efbb2d-7aaf-4dff-b196-c24464674575'::uuid, 'https://github.com/humanlayer/skills', '653b6411c1f70c275a18e37673b042ff99f67ceb'),
    ('560d5ba7-99ee-4162-80b0-6fcc9f98cfe2'::uuid, 'https://github.com/vinvcn/mattpocock-skills-zh-CN', 'bf98e53f92089fec9b4885f128a565d7eac0337f'),
    ('fb115f34-cd92-4d2d-b965-71ad9c3a7991'::uuid, 'https://github.com/Ryze-AI-Adgent/open-seo-mcp-skills', '81ac50e95131c8172b3afd9ac4994de6ae455a04'),
    ('1cfbd689-282b-40cb-84e8-ea9446e2b937'::uuid, 'https://github.com/BuilderIO/skills', '68d86be7a0e1ad585406cbe19cdf7ec8a8504498'),
    ('6b8c66f5-8e08-4553-ab7a-b60a4cbc91c4'::uuid, 'https://github.com/eternityspring/shuohao-skills', 'c27ea0e49c009a2b3c43dec40b702597ab56e1d9'),
    ('b7474e48-d96f-422b-a348-5d50cdaf40dd'::uuid, 'https://github.com/google-gemini/gemini-skills', '832c8f94114dc343d86ff27296fe9335b45affa0'),
    ('c70a5f56-93ad-4cb0-889b-e7b30725f6d1'::uuid, 'https://github.com/dexhunter/seedance2-skill', '516284d5bab58361bfdfed3cc96cee3e837d4c44'),
    ('60546e1f-b0ad-4880-952d-2e9eb11bcf9c'::uuid, 'https://github.com/davidondrej/skills', '7874889bd037d411f6079e38ee8601557c4a8995'),
    ('e69a0914-0177-467f-b484-b619367c4be9'::uuid, 'https://github.com/KKKKhazix/human-writing', '4fda173f3fef7fb808f3eba991eeb2528ea4b189'),
    ('0b3f23d4-9144-4fdb-97b0-4fedae779f04'::uuid, 'https://github.com/Dimillian/Skills', '05ba982bfeb0d77d3c97d4542b0ee15034d05f84'),
    ('68952204-a68a-4716-99a0-cb2eeaa45eb2'::uuid, 'https://github.com/sanyuan0704/sanyuan-skills', '08b6572ef108f22d4e8a3ecf9182a4bbef097744'),
    ('f20592ef-67e0-4e60-8fae-a0312cbd16df'::uuid, 'https://github.com/charlie947/social-media-skills', '8cefb5b6d03757885faa6918bd8bfaef202a83db'),
    ('6b16bb2a-8a03-47e3-acab-1088c42b259c'::uuid, 'https://github.com/gotalab/cc-sdd', 'e2a0c671aef37a482404905b409ab5c27092b25b'),
    ('507c1916-ca68-400e-abb9-4093dfe0ec2c'::uuid, 'https://github.com/axtonliu/axton-obsidian-visual-skills', '1265976d9746a84858b4b7b42fb86a215aa93de9'),
    ('0e304318-4c15-4230-9f52-33278ec0dd62'::uuid, 'https://github.com/plannotator/effective-html', '2ac1dfecb0f2474e75260cb6d3c9b9d6d9b5062e'),
    ('c3e4603d-8468-4210-bd85-8c194e41c55f'::uuid, 'https://github.com/PenglongHuang/chinese-novelist-skill', '6a64a04651036aa519c6354a93d6e01d68a9c22a'),
    ('4ab93a6a-3cb0-4a81-b9e3-62d8bc422239'::uuid, 'https://github.com/pasky/chrome-cdp-skill', 'ffea76a24b0471663ddd9d9f24335bbc442b6266'),
    ('71fb8732-5378-4bc3-95c1-0db6c595c55d'::uuid, 'https://github.com/lackeyjb/playwright-skill', 'dd47a6a023e249eb1b36e9e943eab89d0900865d'),
    ('debd4a79-5282-4f89-a78e-d82f2fbada08'::uuid, 'https://github.com/bergside/awesome-design-skills', 'f631a09b4fcc0166f2e2c1a8c81906ef680c57e8'),
    ('2079dc43-54b4-4d91-819e-e2f9632852dd'::uuid, 'https://github.com/NarratorAI-Studio/narrator-ai-cli-skill', '4b17c6f2175bd532c92db778a847f8fb6bdd3177'),
    ('44487782-0316-43d5-b9ee-e388c159dde5'::uuid, 'https://github.com/cloudflare/skills', 'a18ffe2a99448ebff262fc87915b0fd14bab9b70'),
    ('969269d3-67d9-4465-b9d7-65474e098af2'::uuid, 'https://github.com/Owl-Listener/designer-skills', '9a6930cf84a822eb458624bd11c61aac5bbdf224'),
    ('134f3501-6a3d-41ba-b11c-f98d110efe9f'::uuid, 'https://github.com/typesafe-ai/skills', '65a39f393687675ce170e6094757de20370365b9'),
    ('59283597-a19e-47ee-b059-091ca2137a5b'::uuid, 'https://github.com/badlogic/pi-skills', '90bb51cae36515a648515b633a81c0c6efc8c74d'),
    ('0c9f553c-c2f6-4f48-9596-169c83a9326b'::uuid, 'https://github.com/Haojae/scipilot-figure-skill', '43098ddb9e6a6d142218540c114f9ed38922fc42'),
    ('3da44e18-3069-461f-b7f8-f8394305fd28'::uuid, 'https://github.com/chengyi-ai/native-subtitle-quote-image', 'd68c80bd4b42e7f6ab5cade12241772f9a6273bf'),
    ('73debfb1-a72e-414d-bc67-48bddbfc1e2b'::uuid, 'https://github.com/Appllama/appllama-skills', 'dd5caaec3d5d50ad7fc0324da238119c6b7c3707'),
    ('22984608-1f28-4e04-ac65-4a1df5316631'::uuid, 'https://github.com/Adkid-Zephyr/anti-defensive-writing-Skill', '82d31402caa0db1790026824399044538483171b'),
    ('4c397a36-f14a-49c1-92ef-c521c7a76e1f'::uuid, 'https://github.com/elayadesign/ai-design-skills', '1c1e97cb9878e236552c772092dda7adcdddbcb2'),
    ('29a96dda-9078-4f61-b15b-b82d18a4dcb1'::uuid, 'https://github.com/larashero3-dotcom/writing-dna-skill', 'ee3d97ee27268004b5187d97711161f44fc4aae4'),
    ('98562b95-7a3e-4447-8e45-545104f5792e'::uuid, 'https://github.com/noamseg/interview-coach-skill', '634a8dd8689e0420c21e5f0c8ae3cfa9e1a7ab7e'),
    ('f6c87e1d-3190-4fcf-878e-c5fc6e4c1ee5'::uuid, 'https://github.com/amElnagdy/delegate-skills', '8ef02103ad99b53801f2b13d04755313fbbfafb2'),
    ('bf56ce9a-739c-4032-b0d7-a82e51eed23e'::uuid, 'https://github.com/Weizhena/Deep-Research-skills', '6ce38f60e3f8b22502c29873f96503a4e0c5addb'),
    ('90126225-ab52-45d7-9a8c-e83b7fc31a42'::uuid, 'https://github.com/Sahir619/fable-method', '9924067e82bd48cf3b0426378db93238bfb33e9b'),
    ('317484cb-5601-4f3f-a170-b481b3fe9bcc'::uuid, 'https://github.com/LottieFiles/motion-design-skill', 'f9a8a041b85185ee4881b3471d3415e939aac772'),
    ('b37e7b43-fe77-48f5-9145-cda082ceff8f'::uuid, 'https://github.com/cbrock84/headcount', '98d1c17d480f606060102a781f9a8601690685f7'),
    ('70ebef4e-0c2e-47c7-81e9-2159e7fb0370'::uuid, 'https://github.com/yetone/native-feel-skill', '9bd88c6378e1a80a4da165f3ee7bebb761a74945'),
    ('41985f1b-8692-4318-9eff-3407583f1630'::uuid, 'https://github.com/nanaism/yomiyasu', '373356eb874af5184962c88e925ea7eb58450318'),
    ('e2b36993-e09c-41bb-8ab4-b72007044de6'::uuid, 'https://github.com/adamlyttleapps/claude-skill-aso-appstore-screenshots', '87e1c8054eec3a601835770e7d208a79d3ebcb19'),
    ('f7c0d797-8c33-427a-8d44-1a5165544eab'::uuid, 'https://github.com/tourmind-com/Tourmind-Booking-Skills', '6ffd73c352b0b0affb61554d632d7c125c64be6c'),
    ('0d6f18a8-4098-49c8-b439-4d5132ec4583'::uuid, 'https://github.com/Jakeschincariol/linkedin-agent-skill', 'add2c23882fe79180737d242ff80a5da205eda6a'),
    ('84be1c8d-d051-4953-82d9-0831a6d254bf'::uuid, 'https://github.com/GBSOSS/skill-from-masters', 'c4d27d29bfda00f73c23abd4990f700a6d3df480'),
    ('75be7142-7255-470e-862f-776b9bac817c'::uuid, 'https://github.com/PrathamLearnsToCode/paper2code', 'fcffce7a1250659ed74f2a96cdf54595c92306c4'),
    ('f80ca7db-ab49-4421-a2d9-51475245726d'::uuid, 'https://github.com/imxv/Pretty-mermaid-skills', 'e234ab73c2992f03c36db04fd55ebb90abca9c45'),
    ('c434503d-c8b7-4d64-bda0-3bedb5f4b6ac'::uuid, 'https://github.com/ai-evals-course/evals-skills', '80d5f7b0127c7572ed9e9339937adbfd7240ffeb'),
    ('ec4aa936-4097-45a9-acbc-1f727d9f9aef'::uuid, 'https://github.com/hamen/material-3-skill', '14385f2bf3804d8779f8b4db2604211f1e70b4c1'),
    ('f37fcfce-15d9-4217-b7da-ca96cc50d543'::uuid, 'https://github.com/jsmastery-pro/skills', '43b69e44c9ca905fe3a3418ccdf4102255e20d40'),
    ('fc4f3807-a4ea-4f4e-98c4-b8ac467172ad'::uuid, 'https://github.com/backnotprop/pstack', '3a604672c46cd8187d2b19980eae0a34f9f91138'),
    ('13cb670a-6ac3-402a-8651-d1e37bb0ed5b'::uuid, 'https://github.com/ziguishian/xhs-visual-director-skill', '5c730c688f2c7e64f798d611608997ffba43813d'),
    ('371c5011-091d-4810-9685-0ed008e32c7d'::uuid, 'https://github.com/truongduy2611/app-store-preflight-skills', 'e52e007036fb6edea104b6b49eb01f69c155ad51'),
    ('41943e1e-868e-40ab-b9f5-9591df621d75'::uuid, 'https://github.com/gamedev-skills/awesome-gamedev-agent-skills', '0a70cfc64672d512c5b5b6006b5dcb5cf90dbdbd'),
    ('13b49bc5-be0e-4e09-9e7c-e93f38330369'::uuid, 'https://github.com/boyang-hu/website-rebuild-skill', '830647fbe4e31cda85319df69b48514bd224ad79'),
    ('ef1951bd-5a90-4110-a948-29b5f1ecb839'::uuid, 'https://github.com/lishix520/academic-paper-skills', 'c325557646e9418939ccc7b99171b149ad6314f1'),
    ('f6f0165a-6be0-4533-82e7-7b283f30519f'::uuid, 'https://github.com/bevibing/tutor-skills', '397110c9fefbc6bd5444277686600aec28063c05'),
    ('d7de3e2b-a5e6-436b-a6fa-7ebc218ecc0e'::uuid, 'https://github.com/onvoyage-ai/gtm-engineer-skills', '3777930184a10b25ab36bb2fc4da6c0f6cfcc187'),
    ('750c7019-1ad8-43bb-9800-15e544178407'::uuid, 'https://github.com/huangkiki/dailypaper-skills', '10c9921357dee38c8a342c8dd89b4b773758c104'),
    ('fddb6799-7513-4b5f-8913-6a1e5310525d'::uuid, 'https://github.com/kharmanskyi/open-steps', '4fa744ba8ea06ccf128a39853824c46ac391dd00'),
    ('afb78281-e529-4981-920e-b7081aeec5da'::uuid, 'https://github.com/langchain-ai/langchain-skills', '16a992f09ab3ccfb642dd4f08d350d833d1990bf'),
    ('89a45a16-710e-4863-9f9e-1e63d3e4ff6d'::uuid, 'https://github.com/conorluddy/ios-simulator-skill', 'c535422ab4ee550c8994c179583f805cb0cb01b1'),
    ('1ba7587b-4364-41b0-b4b3-f48647e7f968'::uuid, 'https://github.com/Jakeschincariol/replica-skill', '77c9436fb3d18c3d58169efb8caf4fe906b0dc51'),
    ('a4019cb0-58ea-411c-80e6-83850f0c8053'::uuid, 'https://github.com/amElnagdy/guard-skills', 'ffa26036b7b5e77b20b5d679304a703b6fd1a43d'),
    ('4fa2f88c-f3df-4e3f-a0c5-c563cb5fccf5'::uuid, 'https://github.com/AvdLee/Xcode-Build-Optimization-Agent-Skill', '6bd7b596cd688b1127ded00e812b1b6937ec35d6'),
    ('5da0c6e2-a087-4ed4-a907-67818d61bbea'::uuid, 'https://github.com/pashov/skills', '92b0ea6786e6c210bc9a839e4813d50876c1c550'),
    ('64ede1a6-be64-4ee2-a074-5c3a0e70165a'::uuid, 'https://github.com/Spark-To-Paper-Skills/paperjury', '53c75e86285dc5b38e8d60c6eb0b0adaf4838250'),
    ('63ae1b65-51b0-40c0-9b9f-3928eced00b1'::uuid, 'https://github.com/adamlyttleapps/claude-skill-app-onboarding-questionnaire', '5bc4786d80f2c23de60b3ba02773e919ed8fd091'),
    ('0e535af9-78ad-4d94-a4a3-8147cd43e85a'::uuid, 'https://github.com/ferdinandobons/startup-skill', 'a5f97c317b93caedbb49d28f20e9ec283b2ec087'),
    ('cc28b3c8-8c9d-4fae-acc2-d116c5bbaeba'::uuid, 'https://github.com/MoizIbnYousaf/ai-agent-skills', '6d95c788aa22ce39a4807b9a4c31c758a2036dc6'),
    ('9603d567-0588-4ec3-b499-d827c145c8bf'::uuid, 'https://github.com/carnot-tech/jinba-consulting-pptx-skill', '78aa9fe811e2f747ee38b546d8a4287ddf251ff9'),
    ('904b9827-be08-49b2-9290-f31397f27064'::uuid, 'https://github.com/Gabberflast/academic-pptx-skill', '9f2b703ffe8d1449851617665ab1ffb3516d54ac'),
    ('031891fe-504b-412d-a709-d29b4deb8cab'::uuid, 'https://github.com/libtv-labs/libtv-skills', 'c609246c1eca69f6bc129bcbb5d64c36734e4a4a'),
    ('39b454a0-00de-4b32-8e1f-ea786f5ef189'::uuid, 'https://github.com/nexscope-ai/eCommerce-Skills', 'ee0fb29433d02ccc22e3e6cea9ab4586d49fd42e'),
    ('c5243f03-43ea-4c54-be24-f90feaefb5e9'::uuid, 'https://github.com/raroque/vibe-security-skill', '850938f20f6915e7c3688d85c0a838f7909c87bb'),
    ('e4d19cc0-734e-4289-91f7-ed58b9aeb5b8'::uuid, 'https://github.com/Kappaemme-git/codex-first-customer-finder-skill', 'd3f6964bd989745ac183edbd545c588a68451146'),
    ('4ea19b23-33d2-448a-a662-4453ff11061f'::uuid, 'https://github.com/rorkai/app-store-connect-cli-skills', '9c7e769f09a18237c9bd9c70f70aef65f0cd0391'),
    ('0722e012-eaa4-407c-a935-0b0b0939fb6e'::uuid, 'https://github.com/zhnnky329/MathModeling-skills', '0b46e9c78335624ed3738b86087b6e8ff9ac1f0d'),
    ('c81070ad-1d66-4572-bfe9-c8ac55d10abe'::uuid, 'https://github.com/numman-ali/n-skills', 'fdabc47a713c9e00925296f1d9c65e139dce3ed4'),
    ('ed57220f-6d3f-4003-99a4-5ceff15ba4bd'::uuid, 'https://github.com/agiwhitelist/auteur', '9bca227df9877e60dc45d49783c8cbd885eccd9b'),
    ('ccc18025-a49d-474e-a439-54761c52954f'::uuid, 'https://github.com/Raymondhou0917/speak-human-tw', '2b71bc06fc56c51d0f0f6939ef894b9e83190c19'),
    ('a711520c-dff1-443d-9d37-7e92012d2726'::uuid, 'https://github.com/kostja94/marketing-skills', '8dd89c57395e4dbe079f0387a495c6b9795818a2'),
    ('beacc2cd-409d-41ba-8292-74ec2d82c3b8'::uuid, 'https://github.com/dzhng/skills', 'd51322866ffa298838346960414d18a221b52588'),
    ('5fddd884-a6a1-4505-8658-505d967fa952'::uuid, 'https://github.com/google-gemma/gemma-skills', 'f86bcc6a40c8de2d153f36bac0d02dea217eb39b'),
    ('85a2f09b-78f0-441f-9a9c-0e3fb473447a'::uuid, 'https://github.com/pengjunchi0/codex-visio-paper-figure-skill', '816960dd9608d21d3f47a2af8768c5a00464988a')
), matched AS MATERIALIZED (
    -- Keep an existing system entry; otherwise prefer an already-public copy,
    -- then the oldest ID. Other administrators' copies remain personal.
    SELECT DISTINCT ON (c.request_id) w.id, w.user_id, w.revision FROM agent_workspaces w
    JOIN users u ON u.id=w.user_id AND u.is_admin
    JOIN catalog c ON c.request_id=w.github_import_request_id
      AND c.repository_url=w.github_source->>'repositoryUrl'
      AND c.commit_sha=w.github_source->>'commitSha'
    WHERE NOT w.is_system AND w.deleted_at IS NULL
      AND COALESCE(w.github_source->>'private','false')='false'
      AND NOT EXISTS (SELECT 1 FROM agent_workspaces existing
          WHERE existing.is_system AND existing.github_import_request_id=c.request_id)
    ORDER BY c.request_id,
      EXISTS (SELECT 1 FROM agent_repository_publications p WHERE p.workspace_id=w.id) DESC,
      w.id
), adopted AS (
    UPDATE agent_workspaces w SET user_id=NULL, is_system=true
    FROM matched m WHERE w.id=m.id RETURNING w.id
), audited AS (
    INSERT INTO agent_repository_system_events(workspace_id,actor_user_id,action,revision)
    SELECT m.id,m.user_id,'adopt',m.revision FROM matched m JOIN adopted a ON a.id=m.id
)
-- Verified production grant, 2026-10-10 08:52:28 UTC: this curator's bonus
-- changed from 0 to 199998649 solely for the launch catalog. Reclaim that exact
-- grant even after a partial import. No provenance exists for other accounts;
-- preserve their bonuses, any later changed amount, and all allocated_bytes.
UPDATE agent_workspace_storage_quotas q SET bonus_bytes=0, updated_at=now()
FROM users u WHERE u.id=q.user_id AND u.is_admin
  AND lower(u.email)='cfjwlchangji@gmail.com' AND q.bonus_bytes=199998649;
