% Element-wise lift of 1-arg scalar builtins onto tensors.
x = [1 2 3 4];
y = sqrt(x);
disp(y);

% Trig on a row vector
t = [0 1 2 3];
s = sin(t);
disp(s);
c = cos(t);
disp(c);

% abs over a mixed-sign row, then sqrt of that (positive sign re-derived)
m = [-2 -1 0 1 2];
am = abs(m);
disp(am);
am_sq = sqrt(am);
disp(am_sq);

% Column vector
cv = [1; 4; 9; 16];
cv_sq = sqrt(cv);
disp(cv_sq);

% Matrix
M = [1 4; 9 16];
M_sq = sqrt(M);
disp(M_sq);

% exp / log on a positive row
p = [1 2 4];
ep = exp(p);
disp(ep);
lp = log(p);
disp(lp);

% floor / ceil on a mixed row
f = [1.2 -1.7 0.5];
ff = floor(f);
disp(ff);
fc = ceil(f);
disp(fc);

% isfinite over a row of normal values
z = [1 0 -1];
zf = isfinite(z);
disp(zf);
