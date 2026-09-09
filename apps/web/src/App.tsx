import './styles.css';
import { UploadPage } from './pages/UploadPage';

export default function App() {
  return (
    <>
      <header className="app-header">
        <h1>Automatic Reimbursement Assistant</h1>
        <nav aria-label="主导航">
          <a href="#home">首页</a>
          <a href="#upload">上传凭证</a>
        </nav>
      </header>
      <UploadPage />
    </>
  );
}
